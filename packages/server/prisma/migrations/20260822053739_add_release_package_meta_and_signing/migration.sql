-- AlterTable
ALTER TABLE `app_releases` ADD COLUMN `entry` VARCHAR(255) NULL,
    ADD COLUMN `installStrategy` ENUM('versioned', 'replace', 'notify') NOT NULL DEFAULT 'versioned',
    ADD COLUMN `packageType` ENUM('zip', 'onefile', 'onedir') NOT NULL DEFAULT 'zip',
    ADD COLUMN `postInstall` VARCHAR(500) NULL,
    ADD COLUMN `signature` VARCHAR(128) NULL,
    ADD COLUMN `stripRootDir` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `applications` ADD COLUMN `updateSignPrivateKey` TEXT NULL,
    ADD COLUMN `updateSignPublicKey` VARCHAR(128) NULL;
