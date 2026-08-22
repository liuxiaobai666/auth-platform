<?php

declare(strict_types=1);

namespace JcKami;

/**
 * 一次更新动作的结果。
 *
 * staged 与 applied 是两件事：staged 表示新版本已经落到 versions/<版本>/ 且校验通过，
 * applied 表示 current.txt 指针也切过去了。stage() 只做前者，把切换留给运维时机。
 */
class UpdateResult
{
    public bool $applied;
    public bool $staged;
    public ?string $version;
    public ?string $path;
    public ?string $skippedReason;

    public function __construct(
        bool $applied,
        bool $staged,
        ?string $version,
        ?string $path = null,
        ?string $skippedReason = null
    ) {
        $this->applied = $applied;
        $this->staged = $staged;
        $this->version = $version;
        $this->path = $path;
        $this->skippedReason = $skippedReason;
    }
}
