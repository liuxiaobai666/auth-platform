/**
 * 标准错误码，对应 DEVELOPMENT.md 8.8。
 * 这是客户端唯一可依赖的判断依据：语义一经发布不得修改，只能追加新值。
 */
export const ErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  // 认证与签名
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  TIMESTAMP_EXPIRED: 'TIMESTAMP_EXPIRED',
  NONCE_REPLAYED: 'NONCE_REPLAYED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  PLUGIN_DISABLED: 'PLUGIN_DISABLED',

  // 管理员登录
  BAD_CREDENTIALS: 'BAD_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // 应用与远程管控
  APP_MISMATCH: 'APP_MISMATCH',
  APP_DISABLED: 'APP_DISABLED',
  APP_KILLED: 'APP_KILLED',
  APP_MAINTENANCE: 'APP_MAINTENANCE',
  CLIENT_VERSION_TOO_LOW: 'CLIENT_VERSION_TOO_LOW',

  // 卡密
  LICENSE_NOT_FOUND: 'LICENSE_NOT_FOUND',
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
  LICENSE_BANNED: 'LICENSE_BANNED',
  LICENSE_REVOKED: 'LICENSE_REVOKED',
  LICENSE_NOT_ACTIVATED: 'LICENSE_NOT_ACTIVATED',

  // 设备
  DEVICE_LIMIT_EXCEEDED: 'DEVICE_LIMIT_EXCEEDED',
  DEVICE_NOT_BOUND: 'DEVICE_NOT_BOUND',
  REBIND_NOT_ALLOWED: 'REBIND_NOT_ALLOWED',
  REBIND_LIMIT_EXCEEDED: 'REBIND_LIMIT_EXCEEDED',

  // 次数卡
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  RESERVATION_NOT_ACTIVE: 'RESERVATION_NOT_ACTIVE',

  // 通用
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 -> HTTP 状态码。未列出的一律 400。 */
export const ERROR_HTTP_STATUS: Record<string, number> = {
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,

  [ErrorCode.SIGNATURE_INVALID]: 401,
  [ErrorCode.TIMESTAMP_EXPIRED]: 401,
  [ErrorCode.NONCE_REPLAYED]: 409,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.PLUGIN_DISABLED]: 403,

  [ErrorCode.BAD_CREDENTIALS]: 401,
  [ErrorCode.ACCOUNT_LOCKED]: 423,
  [ErrorCode.ACCOUNT_DISABLED]: 403,
  [ErrorCode.PERMISSION_DENIED]: 403,

  [ErrorCode.APP_MISMATCH]: 403,
  [ErrorCode.APP_DISABLED]: 403,
  [ErrorCode.APP_KILLED]: 403,
  [ErrorCode.APP_MAINTENANCE]: 503,
  [ErrorCode.CLIENT_VERSION_TOO_LOW]: 426,

  [ErrorCode.LICENSE_NOT_FOUND]: 404,
  [ErrorCode.LICENSE_EXPIRED]: 403,
  [ErrorCode.LICENSE_BANNED]: 403,
  [ErrorCode.LICENSE_REVOKED]: 403,
  [ErrorCode.LICENSE_NOT_ACTIVATED]: 403,

  [ErrorCode.DEVICE_LIMIT_EXCEEDED]: 403,
  [ErrorCode.DEVICE_NOT_BOUND]: 404,
  [ErrorCode.REBIND_NOT_ALLOWED]: 403,
  [ErrorCode.REBIND_LIMIT_EXCEEDED]: 403,
  [ErrorCode.QUOTA_EXHAUSTED]: 403,
  [ErrorCode.RESERVATION_NOT_ACTIVE]: 409,

  [ErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

/** 默认中文提示。客户端不得依赖文案判断逻辑，只能依赖 code。 */
export const ERROR_MESSAGE: Record<string, string> = {
  [ErrorCode.INVALID_REQUEST]: '请求参数缺失或格式错误',
  [ErrorCode.UNAUTHORIZED]: '未认证或认证已失效',
  [ErrorCode.FORBIDDEN]: '没有权限执行该操作',
  [ErrorCode.NOT_FOUND]: '资源不存在',
  [ErrorCode.CONFLICT]: '资源冲突',

  [ErrorCode.SIGNATURE_INVALID]: '签名校验失败',
  [ErrorCode.TIMESTAMP_EXPIRED]: '请求时间戳超出允许窗口',
  [ErrorCode.NONCE_REPLAYED]: '随机数重复，疑似重放请求',
  [ErrorCode.TOKEN_INVALID]: '授权令牌无效或已被撤销',
  [ErrorCode.TOKEN_EXPIRED]: '授权令牌已过期',
  [ErrorCode.PLUGIN_DISABLED]: '插件已停用或密钥已吊销',

  [ErrorCode.BAD_CREDENTIALS]: '用户名或密码错误',
  [ErrorCode.ACCOUNT_LOCKED]: '账号已被锁定，请稍后再试',
  [ErrorCode.ACCOUNT_DISABLED]: '账号已被停用',
  [ErrorCode.PERMISSION_DENIED]: '权限不足',

  [ErrorCode.APP_MISMATCH]: '卡密不属于该应用',
  [ErrorCode.APP_DISABLED]: '应用已停用',
  [ErrorCode.APP_KILLED]: '应用已被远程关停',
  [ErrorCode.APP_MAINTENANCE]: '应用维护中，暂停新激活',
  [ErrorCode.CLIENT_VERSION_TOO_LOW]: '客户端版本过低，请升级后使用',

  [ErrorCode.LICENSE_NOT_FOUND]: '卡密不存在',
  [ErrorCode.LICENSE_EXPIRED]: '卡密已过期',
  [ErrorCode.LICENSE_BANNED]: '卡密已被封禁',
  [ErrorCode.LICENSE_REVOKED]: '卡密已作废',
  [ErrorCode.LICENSE_NOT_ACTIVATED]: '卡密尚未激活',

  [ErrorCode.DEVICE_LIMIT_EXCEEDED]: '已达到设备数量上限',
  [ErrorCode.DEVICE_NOT_BOUND]: '该设备未绑定此卡密',
  [ErrorCode.REBIND_NOT_ALLOWED]: '当前套餐不允许换绑设备',
  [ErrorCode.REBIND_LIMIT_EXCEEDED]: '换绑次数已用尽',
  [ErrorCode.QUOTA_EXHAUSTED]: '剩余次数不足',
  [ErrorCode.RESERVATION_NOT_ACTIVE]: '预扣记录已结束，无法操作',

  [ErrorCode.IDEMPOTENCY_CONFLICT]: '幂等键已被相同接口的不同请求占用',
  [ErrorCode.RATE_LIMITED]: '请求过于频繁，请稍后再试',
  [ErrorCode.INTERNAL_ERROR]: '服务端内部错误',
};
