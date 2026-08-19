/**
 * 服务端错误码。客户端只能依赖这些常量判断分支，
 * 绝不要匹配 message 文案 —— 文案会改，code 不会。
 */
export const LicenseErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  TIMESTAMP_EXPIRED: 'TIMESTAMP_EXPIRED',
  NONCE_REPLAYED: 'NONCE_REPLAYED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  PLUGIN_DISABLED: 'PLUGIN_DISABLED',
  APP_MISMATCH: 'APP_MISMATCH',
  APP_DISABLED: 'APP_DISABLED',
  APP_KILLED: 'APP_KILLED',
  APP_MAINTENANCE: 'APP_MAINTENANCE',
  CLIENT_VERSION_TOO_LOW: 'CLIENT_VERSION_TOO_LOW',
  LICENSE_NOT_FOUND: 'LICENSE_NOT_FOUND',
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
  LICENSE_BANNED: 'LICENSE_BANNED',
  LICENSE_REVOKED: 'LICENSE_REVOKED',
  LICENSE_NOT_ACTIVATED: 'LICENSE_NOT_ACTIVATED',
  DEVICE_LIMIT_EXCEEDED: 'DEVICE_LIMIT_EXCEEDED',
  DEVICE_NOT_BOUND: 'DEVICE_NOT_BOUND',
  REBIND_NOT_ALLOWED: 'REBIND_NOT_ALLOWED',
  REBIND_LIMIT_EXCEEDED: 'REBIND_LIMIT_EXCEEDED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // ---- 以下是 SDK 本地产生的错误码，服务端不会返回 ----
  /** 网络不可达，且已超出离线宽限期 */
  NETWORK_UNAVAILABLE: 'NETWORK_UNAVAILABLE',
  /** 本地没有可用的授权凭据，需要先激活 */
  NOT_ACTIVATED_LOCALLY: 'NOT_ACTIVATED_LOCALLY',
  /** 本地凭据被篡改或损坏 */
  LOCAL_STORAGE_TAMPERED: 'LOCAL_STORAGE_TAMPERED',
} as const;

export type LicenseErrorCodeValue =
  (typeof LicenseErrorCode)[keyof typeof LicenseErrorCode];

/** 可以重试的错误。其余一律终止流程并提示用户。 */
export const RETRYABLE_CODES: string[] = [
  LicenseErrorCode.TIMESTAMP_EXPIRED,
  LicenseErrorCode.NONCE_REPLAYED,
  LicenseErrorCode.RATE_LIMITED,
  LicenseErrorCode.INTERNAL_ERROR,
];

export class LicenseError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string, message: string, httpStatus = 0,
    requestId?: string, details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LicenseError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    this.details = details;
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.includes(this.code);
  }
}
