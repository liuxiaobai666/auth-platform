"""远程更新：下载、验签、解压、原子切换。

设计要点：
- 永远不往正在运行的目录里解压。新版本进独立的 versions/<版本>/，
  再改一个指针文件切过去，所以中途断电、断网都不会把用户的软件搞成半新半旧。
- 装之前必须验 Ed25519 签名。哈希只能防传输损坏，防不了篡改——
  能改安装包的人同样能改哈希，只有私钥签的名他伪造不了。
- 解压做路径穿越防护。压缩包里一个 ../../ 就能写到目录之外，
  而更新包恰恰来自网络，这是必须堵死的口子。
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

from . import _ed25519
from .errors import ErrorCode, LicenseError

__all__ = ["UpdatePlan", "UpdateResult", "Updater", "CURRENT_POINTER"]

CURRENT_POINTER = "current.txt"
_SIGN_PREFIX = "jc-kami-release-v1"
_DOWNLOAD_CHUNK = 256 * 1024


class UpdatePlan(object):
    """一次更新的完整描述，由 policy 的 upgrade 段解析而来。"""

    def __init__(self, app_id, upgrade):
        upgrade = upgrade or {}
        package = upgrade.get("package") or {}
        self.app_id = app_id
        self.available = bool(upgrade.get("available"))
        self.required = bool(upgrade.get("required"))
        self.mandatory = bool(upgrade.get("mandatory"))
        self.version = upgrade.get("latest_version")
        self.download_url = upgrade.get("download_url")
        self.sha256 = upgrade.get("sha256")
        self.file_size = upgrade.get("file_size")
        self.signature = upgrade.get("signature")
        self.release_notes = upgrade.get("release_notes")
        self.message = upgrade.get("message")
        self.package_type = package.get("type") or "zip"
        self.install_strategy = package.get("install_strategy") or "versioned"
        self.strip_root_dir = bool(package.get("strip_root_dir"))
        self.entry = package.get("entry")
        self.post_install = package.get("post_install")

    @property
    def signed(self):
        return bool(self.signature)

    def __repr__(self):
        return "<UpdatePlan %s available=%s required=%s>" % (
            self.version, self.available, self.required,
        )


class UpdateResult(object):
    def __init__(self, applied, version, path, restarted=False, skipped_reason=None):
        self.applied = applied
        self.version = version
        self.path = path
        self.restarted = restarted
        self.skipped_reason = skipped_reason

    def __repr__(self):
        return "<UpdateResult applied=%s version=%s>" % (self.applied, self.version)


def _fail(message, code=ErrorCode.INTERNAL_ERROR):
    raise LicenseError(code, message)


def _resolve_strip_prefix(names, strip_root):
    """算出该剥掉的前缀。

    只有「所有条目都在同一个顶层目录下」才剥，比如 YourApp/app.exe → app.exe。
    包本身就是平铺的（app.exe 和 _internal/ 并列）时必须原样保留：
    无脑剥一层会把顶层文件整个丢掉，装出来的版本直接跑不起来。
    """
    if not strip_root:
        return ""
    tops = set()
    for name in names:
        rel = name.replace("\\", "/").strip("/")
        if not rel:
            continue
        parts = rel.split("/")
        if len(parts) == 1:
            return ""  # 顶层直接有文件，说明没有公共根目录
        tops.add(parts[0])
        if len(tops) > 1:
            return ""  # 有多个并列的顶层目录，剥了会撞名
    return tops.pop() + "/" if tops else ""


def _safe_extract(members, dest, strip_prefix):
    """解压并阻断路径穿越。

    压缩包来自网络，里面完全可能藏着 ../../Windows/System32 这样的条目。
    逐个成员算出绝对目标路径，落在 dest 之外的一律拒绝。
    """
    dest_root = os.path.realpath(dest)
    for name, is_dir, extract in members:
        rel = name.replace("\\", "/").lstrip("/")
        if strip_prefix:
            if not rel.startswith(strip_prefix):
                continue
            rel = rel[len(strip_prefix):]
        if not rel or rel in (".", ".."):
            continue
        target = os.path.realpath(os.path.join(dest_root, rel))
        if target != dest_root and not target.startswith(dest_root + os.sep):
            _fail("更新包内含越界路径，已中止：%s" % name)
        if is_dir:
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        extract(target)


def _extract_archive(path, dest, strip_root):
    os.makedirs(dest, exist_ok=True)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            prefix = _resolve_strip_prefix([i.filename for i in infos], strip_root)
            members = [
                (
                    info.filename,
                    info.is_dir(),
                    lambda target, i=info, z=zf: _write_stream(
                        z.open(i), target, i.external_attr >> 16
                    ),
                )
                for info in infos
            ]
            _safe_extract(members, dest, prefix)
        return
    if tarfile.is_tarfile(path):
        with tarfile.open(path) as tf:
            # 符号链接可以指向目录外，直接跳过，宁可少解压也不越界
            infos = [i for i in tf.getmembers() if not (i.issym() or i.islnk())]
            prefix = _resolve_strip_prefix([i.name for i in infos], strip_root)
            members = [
                (
                    info.name,
                    info.isdir(),
                    lambda target, i=info, t=tf: _write_stream(
                        t.extractfile(i), target, i.mode
                    ),
                )
                for info in infos
            ]
            _safe_extract(members, dest, prefix)
        return
    _fail("无法识别的更新包格式，仅支持 zip / tar")


def _write_stream(source, target, mode=0):
    if source is None:
        return
    with source as src, open(target, "wb") as dst:
        shutil.copyfileobj(src, dst, _DOWNLOAD_CHUNK)
    _restore_mode(target, mode)


def _restore_mode(target, mode):
    """恢复压缩包里记录的权限位。

    不恢复的话，从 zip 解出来的可执行文件在 macOS/Linux 上是 644，
    启动器根本起不来——Windows 没有这个概念，所以这个坑只在类 Unix 上炸。

    只取 rwx 九位：setuid/setgid/sticky 一概丢弃。
    更新包来自网络，让它决定这些位等于把提权的口子交出去。
    """
    if not mode or os.name == "nt":
        return
    try:
        os.chmod(target, mode & 0o777)
    except OSError:
        pass  # 文件系统不支持权限位时不影响主流程


class Updater(object):
    """把一次 UpdatePlan 落到磁盘上。

    :param root: 应用根目录，versions/ 和 current.txt 都放在这里
    :param public_key: 应用的验签公钥（base64），必须内置在客户端里。
                       绝不能从服务端下发——那样篡改响应的人可以连公钥一起换。
    :param keep_versions: 保留几个历史版本，用于回滚
    """

    def __init__(self, root, public_key, keep_versions=2, timeout=60):
        if not public_key:
            _fail("必须提供验签公钥：没有它就无法判断安装包是否被篡改")
        self.root = os.path.abspath(root)
        self.public_key = public_key
        self.keep_versions = max(1, int(keep_versions))
        self.timeout = timeout

    # ------------------------------------------------------------------ 路径

    @property
    def versions_dir(self):
        return os.path.join(self.root, "versions")

    @property
    def pointer_path(self):
        return os.path.join(self.root, CURRENT_POINTER)

    def version_path(self, version):
        return os.path.join(self.versions_dir, self._safe_version(version))

    def current_version(self):
        """当前指针指向的版本，没有则返回 None。"""
        try:
            with open(self.pointer_path, "r", encoding="utf-8") as fp:
                value = fp.read().strip()
            return value or None
        except (IOError, OSError):
            return None

    def installed_versions(self):
        try:
            names = os.listdir(self.versions_dir)
        except (IOError, OSError):
            return []
        return sorted(n for n in names if os.path.isdir(os.path.join(self.versions_dir, n)))

    # ------------------------------------------------------------------ 主流程

    def apply(self, plan, progress=None, allow_post_install=False, restart=False):
        """执行更新。任何一步失败都抛 LicenseError，且不会动到当前版本。"""
        if not isinstance(plan, UpdatePlan):
            plan = UpdatePlan(plan.get("app_id"), plan.get("upgrade", plan))
        if not plan.available:
            return UpdateResult(False, plan.version, None, skipped_reason="没有可用更新")
        if plan.install_strategy == "notify":
            # 平台明确表示安装交给宿主自己处理，SDK 不越俎代庖
            return UpdateResult(False, plan.version, None, skipped_reason="策略为 notify，不自动安装")
        if not plan.download_url:
            _fail("更新计划里没有下载地址")
        if self.current_version() == plan.version and os.path.isdir(self.version_path(plan.version)):
            return UpdateResult(False, plan.version, self.version_path(plan.version),
                                skipped_reason="已是该版本")

        staging = tempfile.mkdtemp(prefix="jckami-update-", dir=self._staging_root())
        archive = os.path.join(staging, "package.bin")
        try:
            self._download(plan, archive, progress)
            self._verify(plan, archive)
            target = self._install(plan, archive, staging)
            self._switch(plan.version)
            self._prune()
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        if allow_post_install and plan.post_install:
            self._run_post_install(plan, target)

        result = UpdateResult(True, plan.version, target)
        if restart:
            result.restarted = self.restart()
        return result

    # ------------------------------------------------------------------ 各步

    def _staging_root(self):
        path = os.path.join(self.root, ".updates")
        os.makedirs(path, exist_ok=True)
        return path

    def _download(self, plan, target, progress=None):
        digest = hashlib.sha256()
        received = 0
        try:
            with urllib.request.urlopen(plan.download_url, timeout=self.timeout) as response:
                declared = response.headers.get("Content-Length")
                if plan.file_size and declared and int(declared) != plan.file_size:
                    # 服务端报的长度和签名里的大小对不上，一个字节都不用收
                    _fail("安装包大小与声明不符，已中止下载")
                total = plan.file_size or int(declared or 0)
                with open(target, "wb") as fp:
                    while True:
                        chunk = response.read(_DOWNLOAD_CHUNK)
                        if not chunk:
                            break
                        received += len(chunk)
                        # 声明多大就只收多大，避免被超长响应撑爆磁盘
                        if plan.file_size and received > plan.file_size:
                            _fail("下载内容超出声明大小，已中止")
                        fp.write(chunk)
                        digest.update(chunk)
                        if progress:
                            progress(received, total)
        except LicenseError:
            raise
        except Exception as exc:  # noqa: BLE001 - 网络异常种类多，统一转成 SDK 错误
            _fail("下载更新包失败：%s" % exc, ErrorCode.NETWORK_ERROR)

        if plan.file_size and received != plan.file_size:
            _fail("下载不完整：期望 %s 字节，实际 %s 字节" % (plan.file_size, received))
        self._actual_sha256 = digest.hexdigest()

    def _verify(self, plan, archive):
        actual = getattr(self, "_actual_sha256", None) or self._hash_file(archive)
        if plan.sha256 and actual != plan.sha256:
            _fail("安装包哈希不匹配，可能已损坏或被篡改")
        if not plan.signature:
            _fail("该版本没有签名，拒绝安装。请在后台重新发布以生成签名")
        if plan.file_size is None:
            # file_size 是签名载荷的一部分，缺了就没法拼出正确的待验字符串
            _fail("更新信息缺少 file_size，无法验签")

        payload = "\n".join([
            _SIGN_PREFIX, plan.app_id, plan.version, actual, str(plan.file_size),
        ]).encode("utf-8")
        import base64

        try:
            public_key = base64.b64decode(self.public_key)
            signature = base64.b64decode(plan.signature)
        except Exception:  # noqa: BLE001
            _fail("签名或公钥格式非法")
        if not _ed25519.verify(public_key, payload, signature):
            _fail("签名验证失败，拒绝安装：这个包不是平台签发的")

    def _install(self, plan, archive, staging):
        unpacked = os.path.join(staging, "unpacked")
        if plan.package_type == "onefile" and not zipfile.is_zipfile(archive):
            # 单文件形态：包本身就是可执行文件，不需要解压
            os.makedirs(unpacked, exist_ok=True)
            # entry 来自服务端响应，且不在签名保护范围内。直接拿去拼路径的话，
            # 一个 ../../ 就能把文件写到目录之外，所以只取文件名部分。
            name = os.path.basename((plan.entry or "app.exe").replace("\\", "/")) or "app.exe"
            shutil.copy2(archive, os.path.join(unpacked, name))
        else:
            _extract_archive(archive, unpacked, plan.strip_root_dir)

        target = self.version_path(plan.version)
        pending = target + ".pending"
        shutil.rmtree(pending, ignore_errors=True)
        os.makedirs(self.versions_dir, exist_ok=True)
        shutil.move(unpacked, pending)

        if os.path.isdir(target):
            shutil.rmtree(target, ignore_errors=True)
        # rename 是原子的：要么完整出现，要么完全不存在，不会留下半个版本
        os.rename(pending, target)
        return target

    def _switch(self, version):
        """切换指针。先写临时文件再替换，避免写一半掉电导致指针损坏。"""
        tmp = self.pointer_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fp:
            fp.write(self._safe_version(version))
            fp.flush()
            os.fsync(fp.fileno())
        os.replace(tmp, self.pointer_path)

    def rollback(self, version):
        """回滚到某个已安装版本，只是把指针改回去。"""
        if not os.path.isdir(self.version_path(version)):
            _fail("版本 %s 未安装，无法回滚" % version)
        self._switch(version)
        return self.version_path(version)

    def _prune(self):
        keep = self.current_version()
        versions = [v for v in self.installed_versions() if v != keep]
        # 留最近的几个，其余删掉；保留的用于随时回滚
        for name in versions[: max(0, len(versions) - (self.keep_versions - 1))]:
            shutil.rmtree(os.path.join(self.versions_dir, name), ignore_errors=True)

    def _run_post_install(self, plan, target):
        """执行安装后命令。

        默认不开：这条命令来自服务端且不在签名保护范围内，
        一旦响应被篡改就等于任意代码执行。确实需要时由调用方显式打开。
        """
        try:
            subprocess.run(plan.post_install, shell=True, cwd=target, timeout=600, check=False)
        except Exception as exc:  # noqa: BLE001
            _fail("安装后命令执行失败：%s" % exc)

    def restart(self, launcher=None):
        """重启到新版本。找不到启动器时返回 False，由调用方自行提示用户。"""
        candidates = []
        if launcher:
            candidates.append(launcher)
        for name in ("launcher.exe", "launcher", "launcher.py"):
            candidates.append(os.path.join(self.root, name))
        for path in candidates:
            if not os.path.isfile(path):
                continue
            try:
                if path.endswith(".py"):
                    subprocess.Popen([sys.executable, path], cwd=self.root, close_fds=True)
                else:
                    subprocess.Popen([path], cwd=self.root, close_fds=True)
                return True
            except Exception:  # noqa: BLE001
                continue
        return False

    # ------------------------------------------------------------------ 工具

    @staticmethod
    def _safe_version(version):
        """版本号会被拼进路径，必须挡掉 ../ 之类的字符。"""
        value = str(version or "").strip()
        if not value or not all(c.isalnum() or c in ".-_+" for c in value):
            _fail("版本号非法：%r" % version)
        if value.startswith(".") or ".." in value:
            _fail("版本号非法：%r" % version)
        return value

    @staticmethod
    def _hash_file(path):
        digest = hashlib.sha256()
        with open(path, "rb") as fp:
            for chunk in iter(lambda: fp.read(_DOWNLOAD_CHUNK), b""):
                digest.update(chunk)
        return digest.hexdigest()
