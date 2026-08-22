-- AlterTable
ALTER TABLE `app_releases` ADD COLUMN `installerExternalUrl` VARCHAR(500) NULL,
    ADD COLUMN `installerName` VARCHAR(255) NULL,
    ADD COLUMN `installerPath` VARCHAR(500) NULL,
    ADD COLUMN `installerSha256` VARCHAR(64) NULL,
    ADD COLUMN `installerSize` BIGINT NULL;

-- CreateTable
CREATE TABLE `app_dist_sites` (
    `id` VARCHAR(32) NOT NULL,
    `applicationId` VARCHAR(32) NOT NULL,
    `slug` VARCHAR(64) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `title` VARCHAR(128) NULL,
    `tagline` VARCHAR(255) NULL,
    `logoUrl` VARCHAR(500) NULL,
    `intro` TEXT NULL,
    `purchaseUrl` VARCHAR(500) NULL,
    `supportQq` VARCHAR(64) NULL,
    `supportWechat` VARCHAR(64) NULL,
    `supportEmail` VARCHAR(128) NULL,
    `requireLicense` BOOLEAN NOT NULL DEFAULT true,
    `showChangelog` BOOLEAN NOT NULL DEFAULT true,
    `downloadCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `app_dist_sites_applicationId_key`(`applicationId`),
    UNIQUE INDEX `app_dist_sites_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `app_dist_sites` ADD CONSTRAINT `app_dist_sites_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
