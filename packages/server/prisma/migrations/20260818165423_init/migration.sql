-- CreateTable
CREATE TABLE `admin_users` (
    `id` VARCHAR(32) NOT NULL,
    `username` VARCHAR(64) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `nickname` VARCHAR(64) NOT NULL,
    `email` VARCHAR(128) NULL,
    `isSuperAdmin` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `lastLoginIp` VARCHAR(64) NULL,
    `tokenVersion` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_users_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_roles` (
    `id` VARCHAR(32) NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `description` VARCHAR(255) NULL,
    `permissions` JSON NOT NULL,
    `isBuiltin` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_roles_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_user_roles` (
    `adminUserId` VARCHAR(32) NOT NULL,
    `roleId` VARCHAR(32) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_user_roles_roleId_idx`(`roleId`),
    PRIMARY KEY (`adminUserId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `applications` (
    `id` VARCHAR(32) NOT NULL,
    `appId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `type` ENUM('windows', 'android', 'web', 'api', 'other') NOT NULL DEFAULT 'windows',
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `remark` VARCHAR(500) NULL,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `killMessage` VARCHAR(500) NULL,
    `maintenance` BOOLEAN NOT NULL DEFAULT false,
    `maintenanceMessage` VARCHAR(500) NULL,
    `minVersion` VARCHAR(32) NULL,
    `latestVersion` VARCHAR(32) NULL,
    `forceUpgrade` BOOLEAN NOT NULL DEFAULT false,
    `upgradeMessage` VARCHAR(500) NULL,
    `noticeEnabled` BOOLEAN NOT NULL DEFAULT false,
    `noticeLevel` ENUM('info', 'warning', 'critical') NOT NULL DEFAULT 'info',
    `noticeTitle` VARCHAR(128) NULL,
    `noticeContent` TEXT NULL,
    `policyTtlSeconds` INTEGER NOT NULL DEFAULT 300,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `applications_appId_key`(`appId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `application_plugins` (
    `id` VARCHAR(32) NOT NULL,
    `pluginId` VARCHAR(64) NOT NULL,
    `applicationId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `version` VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    `runtime` ENUM('sdk', 'http', 'webhook', 'service') NOT NULL DEFAULT 'sdk',
    `endpoint` VARCHAR(255) NULL,
    `status` ENUM('draft', 'testing', 'active', 'disabled') NOT NULL DEFAULT 'testing',
    `tokenHash` VARCHAR(64) NOT NULL,
    `tokenCipher` TEXT NOT NULL,
    `tokenMasked` VARCHAR(64) NOT NULL,
    `secretCipher` TEXT NOT NULL,
    `secretMasked` VARCHAR(64) NOT NULL,
    `prevSecretCipher` TEXT NULL,
    `prevSecretExpiresAt` DATETIME(3) NULL,
    `config` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `application_plugins_pluginId_key`(`pluginId`),
    UNIQUE INDEX `application_plugins_tokenHash_key`(`tokenHash`),
    INDEX `application_plugins_applicationId_idx`(`applicationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plans` (
    `id` VARCHAR(32) NOT NULL,
    `applicationId` VARCHAR(32) NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `durationDays` INTEGER NULL,
    `deviceLimit` INTEGER NOT NULL DEFAULT 1,
    `allowRebind` BOOLEAN NOT NULL DEFAULT true,
    `rebindLimit` INTEGER NULL,
    `price` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `offlineGraceHours` INTEGER NOT NULL DEFAULT 72,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `plans_applicationId_idx`(`applicationId`),
    UNIQUE INDEX `plans_applicationId_code_key`(`applicationId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_keys` (
    `id` VARCHAR(32) NOT NULL,
    `applicationId` VARCHAR(32) NOT NULL,
    `planId` VARCHAR(32) NOT NULL,
    `keyHash` VARCHAR(64) NOT NULL,
    `keyCipher` TEXT NOT NULL,
    `keyMasked` VARCHAR(64) NOT NULL,
    `keyPrefix` VARCHAR(16) NOT NULL,
    `status` ENUM('unused', 'active', 'expired', 'banned', 'revoked') NOT NULL DEFAULT 'unused',
    `durationDays` INTEGER NULL,
    `deviceLimit` INTEGER NOT NULL DEFAULT 1,
    `allowRebind` BOOLEAN NOT NULL DEFAULT true,
    `rebindLimit` INTEGER NULL,
    `rebindCount` INTEGER NOT NULL DEFAULT 0,
    `offlineGraceHours` INTEGER NOT NULL DEFAULT 72,
    `batchId` VARCHAR(32) NOT NULL,
    `note` VARCHAR(255) NULL,
    `activatedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `tokenVersion` INTEGER NOT NULL DEFAULT 0,
    `bannedAt` DATETIME(3) NULL,
    `bannedReason` VARCHAR(255) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(255) NULL,
    `createdBy` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `license_keys_keyHash_key`(`keyHash`),
    INDEX `license_keys_applicationId_status_idx`(`applicationId`, `status`),
    INDEX `license_keys_keyPrefix_idx`(`keyPrefix`),
    INDEX `license_keys_batchId_idx`(`batchId`),
    INDEX `license_keys_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_devices` (
    `id` VARCHAR(32) NOT NULL,
    `licenseId` VARCHAR(32) NOT NULL,
    `deviceId` VARCHAR(128) NOT NULL,
    `deviceName` VARCHAR(128) NULL,
    `clientVersion` VARCHAR(32) NULL,
    `status` ENUM('active', 'unbound') NOT NULL DEFAULT 'active',
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastIp` VARCHAR(64) NULL,
    `unboundAt` DATETIME(3) NULL,
    `unboundBy` VARCHAR(64) NULL,
    `unboundReason` VARCHAR(255) NULL,

    INDEX `license_devices_deviceId_idx`(`deviceId`),
    UNIQUE INDEX `license_devices_licenseId_deviceId_key`(`licenseId`, `deviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_activations` (
    `id` VARCHAR(32) NOT NULL,
    `licenseId` VARCHAR(32) NULL,
    `applicationId` VARCHAR(32) NULL,
    `pluginId` VARCHAR(64) NULL,
    `deviceId` VARCHAR(128) NULL,
    `action` ENUM('activate', 'verify', 'deactivate', 'status', 'policy') NOT NULL,
    `success` BOOLEAN NOT NULL,
    `code` VARCHAR(64) NULL,
    `message` VARCHAR(255) NULL,
    `clientVersion` VARCHAR(32) NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `requestId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_activations_licenseId_createdAt_idx`(`licenseId`, `createdAt`),
    INDEX `license_activations_applicationId_createdAt_idx`(`applicationId`, `createdAt`),
    INDEX `license_activations_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_token_revocations` (
    `jti` VARCHAR(64) NOT NULL,
    `licenseId` VARCHAR(32) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_token_revocations_licenseId_idx`(`licenseId`),
    INDEX `license_token_revocations_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`jti`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_key_exports` (
    `id` VARCHAR(32) NOT NULL,
    `adminUserId` VARCHAR(32) NOT NULL,
    `applicationId` VARCHAR(32) NULL,
    `batchId` VARCHAR(32) NULL,
    `filter` JSON NULL,
    `count` INTEGER NOT NULL,
    `ip` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_key_exports_adminUserId_createdAt_idx`(`adminUserId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_releases` (
    `id` VARCHAR(32) NOT NULL,
    `applicationId` VARCHAR(32) NOT NULL,
    `version` VARCHAR(32) NOT NULL,
    `channel` ENUM('stable', 'beta') NOT NULL DEFAULT 'stable',
    `fileName` VARCHAR(255) NULL,
    `filePath` VARCHAR(500) NULL,
    `fileSize` BIGINT NULL,
    `sha256` VARCHAR(64) NULL,
    `externalUrl` VARCHAR(500) NULL,
    `releaseNotes` TEXT NULL,
    `isMandatory` BOOLEAN NOT NULL DEFAULT false,
    `rolloutPercent` INTEGER NOT NULL DEFAULT 100,
    `status` ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
    `downloadCount` INTEGER NOT NULL DEFAULT 0,
    `publishedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `app_releases_applicationId_status_idx`(`applicationId`, `status`),
    UNIQUE INDEX `app_releases_applicationId_version_channel_key`(`applicationId`, `version`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_records` (
    `id` VARCHAR(32) NOT NULL,
    `pluginId` VARCHAR(64) NOT NULL,
    `endpoint` VARCHAR(128) NOT NULL,
    `idemKey` VARCHAR(128) NOT NULL,
    `requestHash` VARCHAR(64) NOT NULL,
    `statusCode` INTEGER NOT NULL,
    `responseBody` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `idempotency_records_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `idempotency_records_pluginId_endpoint_idemKey_key`(`pluginId`, `endpoint`, `idemKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(32) NOT NULL,
    `adminUserId` VARCHAR(32) NULL,
    `username` VARCHAR(64) NULL,
    `action` VARCHAR(64) NOT NULL,
    `targetType` VARCHAR(64) NULL,
    `targetId` VARCHAR(64) NULL,
    `detail` JSON NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_adminUserId_createdAt_idx`(`adminUserId`, `createdAt`),
    INDEX `audit_logs_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `audit_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_logs` (
    `id` VARCHAR(32) NOT NULL,
    `username` VARCHAR(64) NOT NULL,
    `adminUserId` VARCHAR(32) NULL,
    `success` BOOLEAN NOT NULL,
    `failReason` VARCHAR(64) NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_logs_username_createdAt_idx`(`username`, `createdAt`),
    INDEX `login_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_request_logs` (
    `id` VARCHAR(32) NOT NULL,
    `requestId` VARCHAR(64) NOT NULL,
    `method` VARCHAR(8) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `pluginId` VARCHAR(64) NULL,
    `adminUserId` VARCHAR(32) NULL,
    `statusCode` INTEGER NOT NULL,
    `code` VARCHAR(64) NULL,
    `durationMs` INTEGER NOT NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `api_request_logs_createdAt_idx`(`createdAt`),
    INDEX `api_request_logs_pluginId_createdAt_idx`(`pluginId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `admin_user_roles` ADD CONSTRAINT `admin_user_roles_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `admin_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_user_roles` ADD CONSTRAINT `admin_user_roles_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `admin_roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `application_plugins` ADD CONSTRAINT `application_plugins_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plans` ADD CONSTRAINT `plans_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_keys` ADD CONSTRAINT `license_keys_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_keys` ADD CONSTRAINT `license_keys_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_devices` ADD CONSTRAINT `license_devices_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `license_keys`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_activations` ADD CONSTRAINT `license_activations_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `license_keys`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_activations` ADD CONSTRAINT `license_activations_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_key_exports` ADD CONSTRAINT `license_key_exports_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_releases` ADD CONSTRAINT `app_releases_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `admin_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
