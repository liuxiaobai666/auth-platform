"""卡密平台 Python 客户端 SDK。

零依赖，只用标准库。支持桌面应用与服务端两种接入方式。
"""

from .client import LicenseClient
from .device import resolve_device_id
from .errors import ErrorCode, LicenseError, RETRYABLE_CODES
from .storage import MemoryStorage, SecureStorage
from .updater import UpdatePlan, UpdateResult, Updater

__version__ = "1.0.0"
__all__ = [
    "LicenseClient",
    "LicenseError",
    "ErrorCode",
    "RETRYABLE_CODES",
    "SecureStorage",
    "MemoryStorage",
    "resolve_device_id",
    "Updater",
    "UpdatePlan",
    "UpdateResult",
]
