<?php

declare(strict_types=1);

namespace JcKami;

/**
 * 授权相关异常。
 *
 * 业务分支请用 {@see getCode()} 返回的错误码判断，不要匹配 message。
 */
class LicenseError extends \RuntimeException
{
    private string $errorCode;
    private int $httpStatus;
    private ?string $requestId;
    private array $details;

    public function __construct(
        string $errorCode,
        string $message,
        int $httpStatus = 0,
        ?string $requestId = null,
        array $details = []
    ) {
        parent::__construct($message);
        $this->errorCode = $errorCode;
        $this->httpStatus = $httpStatus;
        $this->requestId = $requestId;
        $this->details = $details;
    }

    /** 标准错误码，例如 LICENSE_EXPIRED。 */
    public function errorCode(): string
    {
        return $this->errorCode;
    }

    public function httpStatus(): int
    {
        return $this->httpStatus;
    }

    /** 服务端请求 ID。向服务方报障时提供它能直接定位到日志。 */
    public function requestId(): ?string
    {
        return $this->requestId;
    }

    /** 附加信息，例如限流时的 retry_after、设备超限时的 device_limit。 */
    public function details(): array
    {
        return $this->details;
    }

    public function isRetryable(): bool
    {
        return in_array($this->errorCode, ErrorCode::RETRYABLE, true);
    }
}
