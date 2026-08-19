"""设备指纹。

由机器固有特征加上一份持久化的随机盐哈希而成。加盐是为了不把可反查的硬件信息
直接送到服务端：服务端拿到的是不可逆哈希，既能稳定区分设备，也不构成硬件信息收集。

盐文件丢失会导致指纹变化，等同于换了台机器，需要重新激活或换绑。
"""

import hashlib
import os
import platform
import socket
import uuid


def resolve_device_id(salt_file):
    """生成本机稳定指纹，返回 48 位十六进制字符串。"""
    salt = _load_or_create_salt(salt_file)
    parts = [
        socket.gethostname(),
        platform.system(),
        platform.machine(),
        platform.processor() or "unknown-cpu",
        _mac_address(),
    ]
    raw = "%s|%s" % (salt, "|".join(parts))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:48]


def _mac_address():
    """取本机 MAC。uuid.getnode() 在拿不到真实 MAC 时会返回随机值，
    那种情况下指纹会漂移，所以这里显式标注出来，让盐承担稳定性。"""
    node = uuid.getnode()
    # 第 8 位（多播位）为 1 表示这是 getnode 随机生成的，不是真实网卡地址
    if (node >> 40) % 2:
        return "no-stable-mac"
    return "%012x" % node


def _load_or_create_salt(salt_file):
    try:
        with open(salt_file, "r", encoding="utf-8") as fp:
            existing = fp.read().strip()
        if len(existing) >= 32:
            return existing
    except (IOError, OSError):
        pass  # 文件不存在或不可读，走下面的创建流程

    salt = os.urandom(32).hex()
    directory = os.path.dirname(os.path.abspath(salt_file))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(salt_file, "w", encoding="utf-8") as fp:
        fp.write(salt)
    try:
        os.chmod(salt_file, 0o600)
    except OSError:
        pass  # Windows 上没有 POSIX 权限位，忽略
    return salt
