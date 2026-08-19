# jc-kami/sdk (PHP)

卡密平台 PHP 客户端 SDK。PHP 7.4+，只需 curl / json / hash 扩展。

## 安装

```bash
composer require jc-kami/sdk
```

本地开发时在你的 `composer.json` 里指向仓库路径：

```json
{
  "repositories": [{ "type": "path", "url": "../jc-kami/packages/sdk-php" }],
  "require": { "jc-kami/sdk": "*" }
}
```

## 面向服务端

这个 SDK 是给**网站后端**用的：浏览器 → 你的后端（本 SDK）→ 授权中心。

**浏览器端绝不能持有 `plugin_secret`。** 前端 JS 是明文的，密钥会被直接抠走，
然后任何人都能伪造激活请求。所以不存在"浏览器端 SDK"这种东西。

因此本 SDK 不生成机器指纹、也不在服务器上存本地凭据——设备标识和 `license_token`
都由你保管，存进你自己的数据库或会话。

## 用法

```php
use JcKami\LicenseClient;
use JcKami\LicenseError;
use JcKami\ErrorCode;

$client = new LicenseClient([
    'app_id'         => 'my_site',
    'server_url'     => 'https://license.example.com',
    'plugin_id'      => getenv('JC_PLUGIN_ID'),
    'plugin_token'   => getenv('JC_PLUGIN_TOKEN'),
    'plugin_secret'  => getenv('JC_PLUGIN_SECRET'),
    'client_version' => '1.0.0',
    'on_policy'      => function (array $policy) { /* 公告与升级提示 */ },
]);

// 设备标识必须稳定：用户 ID、安装 ID、客户端上报的机器码都行
$device = LicenseClient::deviceIdFor('user:' . $userId);

// 激活
try {
    $result = $client->activate($licenseKey, $device, '张三的电脑');
    saveToken($userId, $result['license_token']);
} catch (LicenseError $e) {
    match ($e->errorCode()) {
        ErrorCode::LICENSE_NOT_FOUND       => flash('卡密不存在，请检查输入'),
        ErrorCode::LICENSE_EXPIRED         => flash('该卡密已过期'),
        ErrorCode::DEVICE_LIMIT_EXCEEDED   => flash('设备数已满，请先解绑其他设备'),
        default                            => flash($e->getMessage()),
    };
}

// 验证（令牌会滚动续期，记得覆盖你库里存的那个）
$result = $client->verify(loadToken($userId), $device);
saveToken($userId, $result['license_token']);
```

## 方法

| 方法 | 说明 |
| --- | --- |
| `LicenseClient::deviceIdFor(string $stable)` | 由稳定标识派生设备指纹（静态方法） |
| `activate($licenseKey, $deviceId, $deviceName = null, $idempotencyKey = null)` | 激活 |
| `verify($licenseToken, $deviceId)` | 验证，返回新令牌 |
| `deactivate($licenseToken, $deviceId, $reason = null, $idempotencyKey = null)` | 解绑 |
| `status(array $params)` | 查询状态，`license_key` 或 `license_id` 二选一 |
| `fetchPolicy(?string $deviceId = null)` | 拉取远程管控策略 |

## 设备标识怎么选

传给 `deviceIdFor()` 的东西必须**稳定**。

可以用：用户 ID、账号 ID、安装时生成并持久化的 UUID、客户端上报的机器码。

**不要用 IP 或 User-Agent。** 它们会变——用户切个 WiFi、升级下浏览器就被判成新设备，
白白吃掉设备名额，然后来找你投诉。

## 错误处理

分支判断只能依赖 `$e->errorCode()`，不要匹配 `$e->getMessage()`——文案会改，错误码不会。

```php
catch (LicenseError $e) {
    $e->errorCode();    // LICENSE_EXPIRED 等标准错误码
    $e->httpStatus();   // HTTP 状态码
    $e->requestId();    // 服务端请求 ID，报障时提供
    $e->details();      // 附加信息，如 retry_after、device_limit
    $e->isRetryable();  // 是否值得重试
}
```

完整错误码清单与接入细节见 [接入指南](../../docs/INTEGRATION.md)。
