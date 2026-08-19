-- AlterTable
ALTER TABLE `license_devices` ADD COLUMN `quotaReserved` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `quotaTotal` INTEGER NULL,
    ADD COLUMN `quotaUsed` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `license_keys` ADD COLUMN `quotaPerDevice` INTEGER NULL;

-- AlterTable
ALTER TABLE `plans` ADD COLUMN `quotaPerDevice` INTEGER NULL;

-- CreateTable
CREATE TABLE `license_reservations` (
    `id` VARCHAR(32) NOT NULL,
    `licenseId` VARCHAR(32) NOT NULL,
    `deviceId` VARCHAR(128) NOT NULL,
    `amount` INTEGER NOT NULL,
    `status` ENUM('reserved', 'confirmed', 'released', 'expired') NOT NULL DEFAULT 'reserved',
    `idempotencyKey` VARCHAR(128) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `pluginId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_reservations_status_expiresAt_idx`(`status`, `expiresAt`),
    INDEX `license_reservations_licenseId_deviceId_idx`(`licenseId`, `deviceId`),
    UNIQUE INDEX `license_reservations_licenseId_idempotencyKey_key`(`licenseId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `license_reservations` ADD CONSTRAINT `license_reservations_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `license_keys`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
