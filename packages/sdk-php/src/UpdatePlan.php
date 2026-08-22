<?php

declare(strict_types=1);

namespace JcKami;

/**
 * 一次更新的完整描述，由 policy 的 upgrade 段解析而来。
 *
 * 这只是一份「服务端说有什么」的描述，本身不可信：真正决定装不装的是
 * {@see Updater} 在安装前做的哈希 + 签名校验。
 */
class UpdatePlan
{
    public string $appId;
    public bool $available;
    public bool $required;
    public bool $mandatory;
    public ?string $version;
    public ?string $downloadUrl;
    public ?string $sha256;
    public ?int $fileSize;
    public ?string $signature;
    public ?string $releaseNotes;
    public ?string $message;
    public string $packageType;
    public string $installStrategy;
    public bool $stripRootDir;
    public ?string $entry;
    public ?string $postInstall;
    /** @var array 原始 upgrade 段，便于排查问题 */
    public array $raw;

    public function __construct(string $appId, ?array $upgrade)
    {
        $upgrade = $upgrade ?: [];
        $package = $upgrade['package'] ?? [];
        if (!is_array($package)) {
            $package = [];
        }

        $this->appId = $appId;
        $this->raw = $upgrade;
        $this->available = !empty($upgrade['available']);
        $this->required = !empty($upgrade['required']);
        $this->mandatory = !empty($upgrade['mandatory']);
        $this->version = $upgrade['latest_version'] ?? null;
        $this->downloadUrl = $upgrade['download_url'] ?? null;
        $this->sha256 = $upgrade['sha256'] ?? null;
        $this->fileSize = isset($upgrade['file_size']) ? (int) $upgrade['file_size'] : null;
        $this->signature = $upgrade['signature'] ?? null;
        $this->releaseNotes = $upgrade['release_notes'] ?? null;
        $this->message = $upgrade['message'] ?? null;
        $this->packageType = $package['type'] ?? 'zip';
        $this->installStrategy = $package['install_strategy'] ?? 'versioned';
        $this->stripRootDir = !empty($package['strip_root_dir']);
        $this->entry = $package['entry'] ?? null;
        $this->postInstall = $package['post_install'] ?? null;
    }

    /** 是否带签名。没有签名的包一律拒装。 */
    public function isSigned(): bool
    {
        return $this->signature !== null && $this->signature !== '';
    }
}
