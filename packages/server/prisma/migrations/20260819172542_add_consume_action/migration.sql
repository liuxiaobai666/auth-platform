-- AlterTable
ALTER TABLE `license_activations` MODIFY `action` ENUM('activate', 'verify', 'deactivate', 'status', 'policy', 'consume') NOT NULL;
