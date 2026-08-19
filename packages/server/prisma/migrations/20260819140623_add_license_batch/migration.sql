-- CreateTable
CREATE TABLE `license_batches` (
    `id` VARCHAR(32) NOT NULL,
    `applicationId` VARCHAR(32) NOT NULL,
    `planId` VARCHAR(32) NOT NULL,
    `count` INTEGER NOT NULL,
    `prefix` VARCHAR(16) NULL,
    `channel` VARCHAR(64) NULL,
    `note` VARCHAR(255) NULL,
    `createdBy` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_batches_applicationId_createdAt_idx`(`applicationId`, `createdAt`),
    INDEX `license_batches_channel_idx`(`channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `license_batches` ADD CONSTRAINT `license_batches_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_batches` ADD CONSTRAINT `license_batches_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
