<?php

declare(strict_types=1);

namespace JcKami;

/**
 * 卡密平台 PHP 客户端。
 *
 * 这个 SDK 面向**服务端**：网站后端代表终端用户调用授权中心。
 * 因此它不生成机器指纹、也不在服务器上存本地凭据 —— 设备标识和 license_token
 * 都由调用方保管（存进你自己的数据库或会话），每次调用时传入。
 *
 * 浏览器端绝不能持有 plugin_secret：前端 JS 是明文的，密钥会被直接抠走。
 * 正确形态是 浏览器 → 你的后端（用本 SDK）→ 授权中心。
 *
 * 用法：
 * ```php
 * $client = new LicenseClient([
 *     'app_id'        => 'my_site',
 *     'server_url'    => 'https://license.example.com',
 *     'plugin_id'     => getenv('JC_PLUGIN_ID'),
 *     'plugin_token'  => getenv('JC_PLUGIN_TOKEN'),
 *     'plugin_secret' => getenv('JC_PLUGIN_SECRET'),
 * ]);
 *
 * $device = LicenseClient::deviceIdFor('user:' . $userId);
 * $result = $client->activate($licenseKey, $device);
 * saveToDatabase($userId, $result['license_token']);
 * ```
 */
class LicenseClient
{
    private string $appId;
    private string $serverUrl;
    private string $pluginId;
    private string $pluginToken;
    private string $pluginSecret;
    private ?string $clientVersion;
    private string $channel;
    private int $timeoutMs;
    private int $maxRetries;
    /** @var callable|null */
    private $onPolicy;

    /**
     * @param array $options 支持的键：app_id、server_url、plugin_id、plugin_token、
     *                       plugin_secret（必填）；client_version、channel、
     *                       timeout_ms、max_retries、on_policy（选填）
     */
    public function __construct(array $options)
    {
        foreach (['app_id', 'server_url', 'plugin_id', 'plugin_token', 'plugin_secret'] as $key) {
            if (empty($options[$key])) {
                throw new \InvalidArgumentException("选项 {$key} 不能为空");
            }
        }

        $this->appId = $options['app_id'];
        $this->serverUrl = rtrim($options['server_url'], '/');
        $this->pluginId = $options['plugin_id'];
        $this->pluginToken = $options['plugin_token'];
        $this->pluginSecret = $options['plugin_secret'];
        $this->clientVersion = $options['client_version'] ?? null;
        $this->channel = $options['channel'] ?? 'stable';
        $this->timeoutMs = (int) ($options['timeout_ms'] ?? 10000);
        $this->maxRetries = (int) ($options['max_retries'] ?? 2);
        $this->onPolicy = $options['on_policy'] ?? null;
    }

    /**
     * 由一个稳定标识派生设备指纹。
     *
     * 传进来的东西必须**稳定**：用户 ID、安装 ID、客户端上报的机器码都可以。
     * 不要用 IP 或 User-Agent —— 它们会变，用户换个网络或升级浏览器就会被判成新设备，
     * 白白吃掉设备名额。
     */
    public static function deviceIdFor(string $stableIdentifier): string
    {
        if (trim($stableIdentifier) === '') {
            throw new \InvalidArgumentException('设备标识不能为空');
        }
        return substr(hash('sha256', 'jc-kami-device:' . $stableIdentifier), 0, 48);
    }

    // ---------------------------------------------------------------- 对外接口

    /**
     * 激活卡密。成功后请把返回的 license_token 存进你自己的数据库。
     *
     * @param string      $licenseKey     用户输入的卡密
     * @param string      $deviceId       设备标识，见 {@see deviceIdFor()}
     * @param string|null $deviceName     设备展示名，便于用户在后台辨认
     * @param string|null $idempotencyKey 幂等键，重复提交时避免重复激活
     */
    public function activate(
        string $licenseKey,
        string $deviceId,
        ?string $deviceName = null,
        ?string $idempotencyKey = null
    ): array {
        $result = $this->request('POST', '/api/v1/license/activate', [
            'app_id' => $this->appId,
            'license_key' => trim($licenseKey),
            'device_id' => $deviceId,
            'device_name' => $deviceName,
            'client_version' => $this->clientVersion,
            'channel' => $this->channel,
        ], null, $idempotencyKey);

        $this->emitPolicy($result);
        return $result;
    }

    /**
     * 验证授权。每次验证都会换发新令牌，请用返回的 license_token 覆盖你库里存的那个。
     */
    public function verify(string $licenseToken, string $deviceId): array
    {
        $result = $this->request('POST', '/api/v1/license/verify', [
            'app_id' => $this->appId,
            'license_token' => $licenseToken,
            'device_id' => $deviceId,
            'client_version' => $this->clientVersion,
            'channel' => $this->channel,
        ]);

        $this->emitPolicy($result);
        return $result;
    }

    /** 解绑设备。这是「换绑」动作本身，会消耗一次换绑配额。 */
    public function deactivate(
        string $licenseToken,
        string $deviceId,
        ?string $reason = null,
        ?string $idempotencyKey = null
    ): array {
        return $this->request('POST', '/api/v1/license/deactivate', [
            'app_id' => $this->appId,
            'license_token' => $licenseToken,
            'device_id' => $deviceId,
            'reason' => $reason,
        ], null, $idempotencyKey);
    }

    /**
     * 查询授权状态。只读，不签发令牌。
     *
     * @param array $params license_key 或 license_id 二选一，可选 device_id
     */
    public function status(array $params): array
    {
        return $this->request('GET', '/api/v1/license/status', null, array_merge(
            ['app_id' => $this->appId],
            $params
        ));
    }

    /**
     * 拉取远程管控策略。未激活时也能调用。
     *
     * @param string|null $clientVersion 临时覆盖构造时的 client_version，
     *                                   用于「按当前部署版本问一次」而不改客户端配置
     */
    public function fetchPolicy(?string $deviceId = null, ?string $clientVersion = null): array
    {
        $result = $this->request('GET', '/api/v1/license/policy', null, [
            'app_id' => $this->appId,
            'device_id' => $deviceId,
            'client_version' => $clientVersion ?? $this->clientVersion,
            'channel' => $this->channel,
        ]);

        $this->emitPolicy($result);
        return $result['policy'] ?? [];
    }

    /**
     * 问一句「有没有新版本」，返回可直接交给 {@see Updater} 的 UpdatePlan。
     *
     * 这一步只是拿到描述，装不装、什么时候装由调用方决定；
     * Updater 会在安装前重新校验哈希和签名，不会因为这里说有新版就无条件信任。
     *
     * @param string|null $currentVersion 当前部署的版本，服务端据此判断要不要推更新
     */
    public function checkUpdate(?string $currentVersion = null, ?string $deviceId = null): UpdatePlan
    {
        $policy = $this->fetchPolicy($deviceId, $currentVersion);
        return new UpdatePlan($this->appId, $policy['upgrade'] ?? null);
    }

    // ---------------------------------------------------------------- 内部

    private function emitPolicy(array $result): void
    {
        if ($this->onPolicy !== null && !empty($result['policy'])) {
            ($this->onPolicy)($result['policy']);
        }
    }

    /**
     * 按 DEVELOPMENT.md 8.7 组装签名。
     *
     * 签名原文里的 path 必须和服务端看到的完全一致，所以查询串在这里只拼一次，
     * 签名和实际请求共用同一个字符串。
     */
    private function signHeaders(string $method, string $urlPath, string $body): array
    {
        $timestamp = (string) time();
        $nonce = $this->uuid4();
        $payload = implode("\n", [
            strtoupper($method),
            $urlPath,
            $timestamp,
            $nonce,
            hash('sha256', $body),
        ]);

        return [
            'Authorization: Bearer ' . $this->pluginToken,
            'X-Plugin-Id: ' . $this->pluginId,
            'X-Timestamp: ' . $timestamp,
            'X-Nonce: ' . $nonce,
            'X-Signature: ' . hash_hmac('sha256', $payload, $this->pluginSecret),
        ];
    }

    private function request(
        string $method,
        string $path,
        ?array $body = null,
        ?array $query = null,
        ?string $idempotencyKey = null
    ): array {
        $urlPath = $path;
        if ($query) {
            $clean = array_filter($query, static fn($v) => $v !== null && $v !== '');
            if ($clean) {
                $urlPath .= '?' . http_build_query($clean, '', '&', PHP_QUERY_RFC3986);
            }
        }

        $payload = '';
        if ($body !== null) {
            $clean = array_filter($body, static fn($v) => $v !== null);
            $payload = json_encode($clean, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }

        $lastError = null;
        for ($attempt = 0; $attempt <= $this->maxRetries; $attempt++) {
            // 每次重试都重新签名：时间戳和 nonce 必须是新的，否则会被判定重放
            $headers = $this->signHeaders($method, $urlPath, $payload);
            if ($payload !== '') {
                $headers[] = 'Content-Type: application/json';
            }
            if ($idempotencyKey !== null) {
                $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
            }

            $ch = curl_init($this->serverUrl . $urlPath);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => strtoupper($method),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_TIMEOUT_MS => $this->timeoutMs,
                CURLOPT_CONNECTTIMEOUT_MS => $this->timeoutMs,
            ]);
            if ($payload !== '') {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
            }

            $raw = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlError = curl_error($ch);
            // PHP 8.0 起 curl_init 返回对象、由 GC 自动释放，curl_close 成了空操作，
            // 8.5 更是直接标记为废弃会刷 Deprecated 日志。只在 7.x 的资源句柄上调用。
            if (is_resource($ch)) {
                curl_close($ch);
            }

            if ($raw === false) {
                // 连接失败、超时、DNS 解析不了，统一归为网络不可用
                $error = new LicenseError(
                    ErrorCode::NETWORK_UNAVAILABLE,
                    '无法连接授权服务器: ' . $curlError
                );
                if ($attempt === $this->maxRetries) {
                    throw $error;
                }
                $lastError = $error;
                $this->backoff($attempt, $error);
                continue;
            }

            $data = json_decode($raw, true);
            if (!is_array($data)) {
                $data = [];
            }

            if ($status >= 200 && $status < 300) {
                return $data;
            }

            $error = new LicenseError(
                $data['code'] ?? ErrorCode::INTERNAL_ERROR,
                $data['message'] ?? sprintf('请求失败（HTTP %d）', $status),
                $status,
                $data['request_id'] ?? null,
                $data['details'] ?? []
            );
            if (!$error->isRetryable() || $attempt === $this->maxRetries) {
                throw $error;
            }
            $lastError = $error;
            $this->backoff($attempt, $error);
        }

        throw $lastError ?? new LicenseError(ErrorCode::INTERNAL_ERROR, '请求失败');
    }

    private function backoff(int $attempt, LicenseError $error): void
    {
        // 限流错误优先听服务端的 retry_after，其余用指数退避
        $retryAfter = $error->details()['retry_after'] ?? null;
        $seconds = $retryAfter !== null
            ? min((float) $retryAfter, 30.0)
            : 0.5 * (2 ** $attempt);
        usleep((int) ($seconds * 1_000_000));
    }

    private function uuid4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
