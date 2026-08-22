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
| `fetchPolicy(?string $deviceId = null, ?string $clientVersion = null)` | 拉取远程管控策略 |
| `checkUpdate(?string $currentVersion = null, ?string $deviceId = null)` | 查有没有新版本，返回 `UpdatePlan` |

## 远程更新

服务端原子部署：新版本解压进 `versions/<版本>/`，再改一个指针切过去。
中途失败不会让站点变成半新半旧，出问题改回指针就是回滚。

```
/var/www/myapp/
├── current.txt          ← 里面写着 "1.2.0"
├── versions/
│   ├── 1.1.0/
│   └── 1.2.0/
└── .updates/            ← 下载与解压的暂存区，用完即删
```

Web 服务器的 root 指向 `versions/<current.txt 的内容>/`（用软链或在入口脚本里读指针）。

```php
use JcKami\Updater;

// 公钥必须内置在代码/配置里，绝不能从服务端接口拿——
// 能篡改响应的人可以连公钥一起换，验签就形同虚设
$updater = new Updater('/var/www/myapp', file_get_contents('/etc/myapp/update.pub'));

$plan = $client->checkUpdate($updater->currentVersion());
if ($plan->available) {
    // 只下载 + 验签 + 解压，线上仍跑旧版本
    $r = $updater->stage($plan, ['progress' => fn($got, $total) => printf("%d/%d\n", $got, $total)]);
    // …人工确认 / 低峰期…
    $updater->switchTo($r->version);   // 一步切换
}
```

### stage() 还是 apply()

| | 做什么 | 什么时候用 |
| --- | --- | --- |
| `stage($plan, $opts)` | 下载、验签、解压到 `versions/<版本>/`，**不动指针** | **网站默认选它。** 落盘随时能做（碰不到正在被访问的目录），切换时机由部署脚本挑 |
| `apply($plan, $opts)` | 同上，外加切指针 | CLI 工具、单机部署、你确信此刻没有请求在跑 |

`$opts` 支持 `progress`（`callable(int $received, int $total)`）和 `allowPostInstall`（默认 `false`）。

其余方法：`currentVersion()`、`installedVersions()`、`switchTo($version)`、`rollback($version)`。

### 安全约定

- **必须验签才装。** 哈希只防传输损坏——能替换安装包的人同样能替换哈希，只有 Ed25519 签名伪造不了。
  验签依赖 `ext-sodium`（PHP 7.2+ 内置）；**没有它会直接抛错，不会降级成「跳过验签」**。
- **未签名的包一律拒装。** 后台里重新发布一次即可生成签名。
- **解压做路径穿越（Zip Slip）防护。** 包里一个 `../../` 就能写到目录之外，越界条目一律中止。
- **`post_install` 默认不执行。** 这条命令来自服务端且不在签名保护范围内，执行它等于把远程代码执行的口子敞开；
  确有需要时传 `['allowPostInstall' => true]` 显式开启。
- **`strip_root_dir` 只在所有条目共享同一个顶层目录时才剥。** 平铺结构原样保留——
  无脑剥一层会把顶层文件整个丢掉，装出来的版本直接跑不起来。
- 版本号会被拼进路径，只允许字母数字和 `.-_+`，`..` 和绝对路径一律拒绝。
- 下载超出声明大小立即中止。

解压需要 `ext-zip`；缺失时同样明确报错。

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
