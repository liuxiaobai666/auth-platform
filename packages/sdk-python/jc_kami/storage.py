"""本地授权状态存储。

**这里做的是防篡改，不是加密。** 标准库没有 AES，为了让 SDK 保持零依赖，
本地文件用 HMAC-SHA256 做完整性保护：密钥由设备指纹派生，任何手工改动
（比如把「上次验证时间」往前挪来骗过离线宽限期）都会在读取时被发现。

文件里没有卡密明文，只有一枚绑定了本机设备指纹的短期授权令牌，
这枚令牌拷到别的机器上服务端也不认。所以保密性不是这里的主要矛盾，
完整性才是。真正的授权判断始终在服务端。
"""

import hashlib
import hmac
import json
import os


class SecureStorage:
    """带 HMAC 校验的本地状态文件。"""

    def __init__(self, file_path, device_id):
        self.file_path = file_path
        self._key = hashlib.sha256(("jc-kami-state:" + device_id).encode("utf-8")).digest()

    def read(self):
        """返回状态 dict；文件不存在返回 None；被改过则抛 LicenseError。"""
        from .errors import ErrorCode, LicenseError

        try:
            with open(self.file_path, "rb") as fp:
                raw = fp.read()
        except (IOError, OSError):
            return None  # 首次运行，尚未激活

        try:
            signature, payload = raw[:32], raw[32:]
            expected = hmac.new(self._key, payload, hashlib.sha256).digest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError("HMAC mismatch")
            return json.loads(payload.decode("utf-8"))
        except Exception:
            raise LicenseError(
                ErrorCode.LOCAL_STORAGE_TAMPERED,
                "本地授权文件已损坏或被修改，请重新激活",
            )

    def write(self, state):
        payload = json.dumps(state, ensure_ascii=False, sort_keys=True).encode("utf-8")
        signature = hmac.new(self._key, payload, hashlib.sha256).digest()
        directory = os.path.dirname(os.path.abspath(self.file_path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(self.file_path, "wb") as fp:
            fp.write(signature + payload)
        try:
            os.chmod(self.file_path, 0o600)
        except OSError:
            pass

    def clear(self):
        try:
            os.remove(self.file_path)
        except OSError:
            pass  # 本来就不存在，当作已清除


class MemoryStorage:
    """内存存储，进程退出即丢失。

    服务端接入时用这个：网站后端不该把某个终端用户的授权状态写进服务器本地文件，
    应该由调用方自己存进数据库或会话，每次调用时通过 ``license_token`` 传入。
    """

    def __init__(self):
        self._state = None

    def read(self):
        return self._state

    def write(self, state):
        self._state = state

    def clear(self):
        self._state = None
