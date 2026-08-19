"""错误码与异常。

客户端只能依赖 ``code`` 判断分支，不要匹配 ``message``——文案会改，错误码不会。
"""


class ErrorCode:
    """服务端返回的标准错误码，与 DEVELOPMENT.md 8.8 一致。"""

    INVALID_REQUEST = "INVALID_REQUEST"
    SIGNATURE_INVALID = "SIGNATURE_INVALID"
    TIMESTAMP_EXPIRED = "TIMESTAMP_EXPIRED"
    NONCE_REPLAYED = "NONCE_REPLAYED"
    TOKEN_INVALID = "TOKEN_INVALID"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    PLUGIN_DISABLED = "PLUGIN_DISABLED"
    APP_MISMATCH = "APP_MISMATCH"
    APP_DISABLED = "APP_DISABLED"
    APP_KILLED = "APP_KILLED"
    APP_MAINTENANCE = "APP_MAINTENANCE"
    CLIENT_VERSION_TOO_LOW = "CLIENT_VERSION_TOO_LOW"
    LICENSE_NOT_FOUND = "LICENSE_NOT_FOUND"
    LICENSE_EXPIRED = "LICENSE_EXPIRED"
    LICENSE_BANNED = "LICENSE_BANNED"
    LICENSE_REVOKED = "LICENSE_REVOKED"
    LICENSE_NOT_ACTIVATED = "LICENSE_NOT_ACTIVATED"
    DEVICE_LIMIT_EXCEEDED = "DEVICE_LIMIT_EXCEEDED"
    DEVICE_NOT_BOUND = "DEVICE_NOT_BOUND"
    REBIND_NOT_ALLOWED = "REBIND_NOT_ALLOWED"
    REBIND_LIMIT_EXCEEDED = "REBIND_LIMIT_EXCEEDED"
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"

    # ---- 以下由 SDK 本地产生，服务端不会返回 ----
    NETWORK_UNAVAILABLE = "NETWORK_UNAVAILABLE"
    """网络不可达，且已超出离线宽限期。"""

    NOT_ACTIVATED_LOCALLY = "NOT_ACTIVATED_LOCALLY"
    """本地没有授权凭据，需要先激活。"""

    LOCAL_STORAGE_TAMPERED = "LOCAL_STORAGE_TAMPERED"
    """本地凭据被篡改或损坏。"""


#: 值得重试的错误码。其余一律终止流程并提示用户。
RETRYABLE_CODES = frozenset(
    {
        ErrorCode.TIMESTAMP_EXPIRED,
        ErrorCode.NONCE_REPLAYED,
        ErrorCode.RATE_LIMITED,
        ErrorCode.INTERNAL_ERROR,
    }
)


class LicenseError(Exception):
    """授权相关异常。

    :param code: 标准错误码，判断分支只应依赖它
    :param message: 给人看的提示，不要用于逻辑判断
    :param http_status: HTTP 状态码，本地错误为 0
    :param request_id: 服务端请求 ID，报障时提供给服务方
    :param details: 附加信息，例如限流的 ``retry_after``
    """

    def __init__(self, code, message, http_status=0, request_id=None, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.request_id = request_id
        self.details = details or {}

    @property
    def retryable(self):
        return self.code in RETRYABLE_CODES

    def __repr__(self):
        return "LicenseError(code=%r, message=%r)" % (self.code, self.message)
