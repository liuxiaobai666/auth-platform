<?php

declare(strict_types=1);

namespace JcKami;

/**
 * 标准错误码，与 DEVELOPMENT.md 8.8 一致。
 *
 * 判断分支只能依赖这些常量，不要匹配错误文案 —— 文案会改，错误码不会。
 */
final class ErrorCode
{
    public const INVALID_REQUEST = 'INVALID_REQUEST';
    public const SIGNATURE_INVALID = 'SIGNATURE_INVALID';
    public const TIMESTAMP_EXPIRED = 'TIMESTAMP_EXPIRED';
    public const NONCE_REPLAYED = 'NONCE_REPLAYED';
    public const TOKEN_INVALID = 'TOKEN_INVALID';
    public const TOKEN_EXPIRED = 'TOKEN_EXPIRED';
    public const PLUGIN_DISABLED = 'PLUGIN_DISABLED';
    public const APP_MISMATCH = 'APP_MISMATCH';
    public const APP_DISABLED = 'APP_DISABLED';
    public const APP_KILLED = 'APP_KILLED';
    public const APP_MAINTENANCE = 'APP_MAINTENANCE';
    public const CLIENT_VERSION_TOO_LOW = 'CLIENT_VERSION_TOO_LOW';
    public const LICENSE_NOT_FOUND = 'LICENSE_NOT_FOUND';
    public const LICENSE_EXPIRED = 'LICENSE_EXPIRED';
    public const LICENSE_BANNED = 'LICENSE_BANNED';
    public const LICENSE_REVOKED = 'LICENSE_REVOKED';
    public const LICENSE_NOT_ACTIVATED = 'LICENSE_NOT_ACTIVATED';
    public const DEVICE_LIMIT_EXCEEDED = 'DEVICE_LIMIT_EXCEEDED';
    public const DEVICE_NOT_BOUND = 'DEVICE_NOT_BOUND';
    public const REBIND_NOT_ALLOWED = 'REBIND_NOT_ALLOWED';
    public const REBIND_LIMIT_EXCEEDED = 'REBIND_LIMIT_EXCEEDED';
    public const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
    public const RATE_LIMITED = 'RATE_LIMITED';
    public const INTERNAL_ERROR = 'INTERNAL_ERROR';

    /** 网络不可达。由 SDK 本地产生，服务端不会返回。 */
    public const NETWORK_UNAVAILABLE = 'NETWORK_UNAVAILABLE';

    /** 值得重试的错误码，其余一律终止流程。 */
    public const RETRYABLE = [
        self::TIMESTAMP_EXPIRED,
        self::NONCE_REPLAYED,
        self::RATE_LIMITED,
        self::INTERNAL_ERROR,
    ];

    private function __construct()
    {
    }
}
