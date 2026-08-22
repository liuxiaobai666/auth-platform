export { LicenseClient } from './client';
export { LicenseError, LicenseErrorCode, RETRYABLE_CODES } from './errors';
export type { LicenseErrorCodeValue } from './errors';
export { resolveDeviceId } from './device';
export type { LicenseState } from './storage';
export { CURRENT_POINTER, UpdatePlan, Updater } from './updater';
export type { UpdateResult } from './updater';
export { extractArchive, openArchive, resolveStripPrefix, safeExtract } from './archive';
export type { Archive, ArchiveEntry } from './archive';
export { verify as verifyEd25519 } from './ed25519';
export type {
  ActivateResult, ApplyOptions, AppPolicy, ConfirmResult, LicenseOptions, NoticePolicy,
  ReserveResult, StatusResult, UpdatePackageInfo, UpdaterOptions, UpgradePolicy, VerifyResult,
} from './types';
