-- CreateTable
CREATE TABLE `webhook_endpoints` (
    `id` VARCHAR(32) NOT NULL,
    `applicationId` VARCHAR(32) NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `secretCipher` TEXT NOT NULL,
    `secretMasked` VARCHAR(64) NOT NULL,
    `events` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `webhook_endpoints_applicationId_idx`(`applicationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` VARCHAR(32) NOT NULL,
    `endpointId` VARCHAR(32) NOT NULL,
    `eventId` VARCHAR(32) NOT NULL,
    `eventType` VARCHAR(48) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('pending', 'delivered', 'failed', 'dead') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 6,
    `nextRetryAt` DATETIME(3) NULL,
    `lastStatusCode` INTEGER NULL,
    `lastError` VARCHAR(500) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `webhook_deliveries_status_nextRetryAt_idx`(`status`, `nextRetryAt`),
    INDEX `webhook_deliveries_endpointId_createdAt_idx`(`endpointId`, `createdAt`),
    UNIQUE INDEX `webhook_deliveries_endpointId_eventId_key`(`endpointId`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `webhook_endpoints` ADD CONSTRAINT `webhook_endpoints_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_endpointId_fkey` FOREIGN KEY (`endpointId`) REFERENCES `webhook_endpoints`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
