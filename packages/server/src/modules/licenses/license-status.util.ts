import { LicenseStatus } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

export interface LicenseLike {
  status: LicenseStatus;
  expiresAt: Date | null;
}

/**
 * 计算卡密的实际状态。数据库里的 status 可能滞后于时间：
 * 一个 active 卡密过了 expiresAt 就应当被视为 expired，
 * 不依赖定时任务，读取时即时判断，验证流程再把结果落库。
 */
export function effectiveStatus(license: LicenseLike, now = new Date()): LicenseStatus {
  if (license.status === 'active' && license.expiresAt && license.expiresAt <= now) {
    return 'expired';
  }
  return license.status;
}

/** 状态到错误码的映射。unused 在激活场景是正常的，调用方需自行区分。 */
export const STATUS_ERROR: Record<string, string> = {
  expired: ErrorCode.LICENSE_EXPIRED,
  banned: ErrorCode.LICENSE_BANNED,
  revoked: ErrorCode.LICENSE_REVOKED,
  unused: ErrorCode.LICENSE_NOT_ACTIVATED,
};

export function isPermanent(license: { durationDays: number | null }): boolean {
  return license.durationDays === null;
}
