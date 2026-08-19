using System.Collections.Generic;

namespace JcKami
{
    /// <summary>
    /// 标准错误码，与 DEVELOPMENT.md 8.8 一致。
    /// 判断分支只能依赖这些常量，不要匹配错误文案 —— 文案会改，错误码不会。
    /// </summary>
    public static class ErrorCode
    {
        public const string InvalidRequest = "INVALID_REQUEST";
        public const string SignatureInvalid = "SIGNATURE_INVALID";
        public const string TimestampExpired = "TIMESTAMP_EXPIRED";
        public const string NonceReplayed = "NONCE_REPLAYED";
        public const string TokenInvalid = "TOKEN_INVALID";
        public const string TokenExpired = "TOKEN_EXPIRED";
        public const string PluginDisabled = "PLUGIN_DISABLED";
        public const string AppMismatch = "APP_MISMATCH";
        public const string AppDisabled = "APP_DISABLED";
        public const string AppKilled = "APP_KILLED";
        public const string AppMaintenance = "APP_MAINTENANCE";
        public const string ClientVersionTooLow = "CLIENT_VERSION_TOO_LOW";
        public const string LicenseNotFound = "LICENSE_NOT_FOUND";
        public const string LicenseExpired = "LICENSE_EXPIRED";
        public const string LicenseBanned = "LICENSE_BANNED";
        public const string LicenseRevoked = "LICENSE_REVOKED";
        public const string LicenseNotActivated = "LICENSE_NOT_ACTIVATED";
        public const string DeviceLimitExceeded = "DEVICE_LIMIT_EXCEEDED";
        public const string DeviceNotBound = "DEVICE_NOT_BOUND";
        public const string RebindNotAllowed = "REBIND_NOT_ALLOWED";
        public const string RebindLimitExceeded = "REBIND_LIMIT_EXCEEDED";
        public const string IdempotencyConflict = "IDEMPOTENCY_CONFLICT";
        public const string RateLimited = "RATE_LIMITED";
        public const string InternalError = "INTERNAL_ERROR";

        // ---- 以下由 SDK 本地产生，服务端不会返回 ----

        /// <summary>网络不可达，且已超出离线宽限期。</summary>
        public const string NetworkUnavailable = "NETWORK_UNAVAILABLE";

        /// <summary>本地没有授权凭据，需要先激活。</summary>
        public const string NotActivatedLocally = "NOT_ACTIVATED_LOCALLY";

        /// <summary>本地凭据被篡改或损坏。</summary>
        public const string LocalStorageTampered = "LOCAL_STORAGE_TAMPERED";

        /// <summary>值得重试的错误码，其余一律终止流程并提示用户。</summary>
        public static readonly HashSet<string> Retryable = new HashSet<string>
        {
            TimestampExpired, NonceReplayed, RateLimited, InternalError,
        };
    }
}
