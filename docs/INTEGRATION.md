# 接入指南

本文档面向**接入方开发者**：你要把自己的软件或网站接到卡密平台上收费。

平台侧的设计与部署见 [DEVELOPMENT.md](../DEVELOPMENT.md) 和 [README.md](../README.md)。

---

## 1. 能用什么语言接

任何能发 HTTP 请求、能算 HMAC-SHA256 的语言都可以。协议就是普通 REST + 签名头，
没有私有二进制格式，没有必须用的运行时。

现成 SDK：

| 语言 | 位置 | 定位 |
| --- | --- | --- |
| Node.js | [`packages/sdk-node`](../packages/sdk-node) | 桌面（Electron）与服务端通用 |
| Python | [`packages/sdk-python`](../packages/sdk-python) | 桌面工具与服务端通用，零依赖 |
| PHP | [`packages/sdk-php`](../packages/sdk-php) | 网站后端 |
| C# / .NET | [`packages/sdk-csharp`](../packages/sdk-csharp) | Windows 桌面软件，兼容 .NET Framework 4.6.1+ |

没有对应 SDK 的语言（Java、Go、易语言、C++ 等），照着第 3 节的协议自己实现即可，
核心就是一个 HMAC 和五个请求头，通常一两百行就能写完。

### 浏览器端不能直接接

**前端 JavaScript 不能持有 `plugin_secret`。** JS 代码是明文的，随便打开控制台就能把密钥抠走，
之后任何人都能伪造激活请求、给自己发授权。

网站接入的正确形态：

```text
浏览器  →  你自己的后端（装 SDK，持有密钥）  →  卡密平台
```

浏览器只跟你自己的后端说话，密钥只存在于你的服务器环境变量里。

---

## 2. 五分钟跑通

### 第 1 步：在后台创建应用

登录管理后台 → **应用管理 → 新建应用**。填 `app_id`（小写字母、数字、下划线，创建后不可改）。

保存后会弹出一副接入凭据，**明文只显示这一次**：

```text
plugin_id      my_app_default
plugin_token   pk_xxxxxxxxxxxx
plugin_secret  sk_xxxxxxxxxxxx
```

存好。忘了也不要紧——之后在应用行的「接入凭据」里能重新查看，但每次查看都会记入审计日志。

### 第 2 步：创建套餐

**套餐管理 → 新建套餐**。套餐决定这张卡能用多久、能绑几台设备、能换绑几次：

| 字段 | 含义 |
| --- | --- |
| 有效期 | 限时卡填天数（激活后开始计算），或勾选永久卡 |
| 设备上限 | 一张卡最多同时绑定几台设备 |
| 允许换绑 | 关掉的话用户不能自助解绑，只能找客服 |
| 换绑次数 | 用户主动解绑的次数上限，留空表示不限 |
| 离线宽限 | 断网后还能用多久（小时）。填 0 表示每次启动必须联网 |

### 第 3 步：生成卡密

**卡密管理 → 生成卡密**。选套餐、填数量，可加前缀（如 `VIP`）。

**明文卡密只在生成后完整展示这一次，请务必下载保存。** 之后要拿明文必须走导出流程，
需要单独的 `license:export` 权限，且每次导出都会记录操作者、时间、IP 和条数。

### 第 4 步：接入代码

以 Python 桌面应用为例：

```python
from jc_kami import LicenseClient, LicenseError, ErrorCode

client = LicenseClient(
    app_id="my_app",
    server_url="https://license.example.com",
    plugin_id="my_app_default",
    plugin_token="pk_...",
    plugin_secret="sk_...",
    client_version="1.0.0",
)

# 用户输入卡密后调一次
client.activate(user_input)

# 之后每次启动调一次
client.verify()
```

跑通了就可以开始卖了。

---

## 3. 协议规范（自己实现 SDK 时看这里）

所有接口以 `/api/v1` 为前缀，生产环境必须走 HTTPS。

### 3.1 认证：两套凭据各司其职

| 凭据 | 放在哪 | 作用 |
| --- | --- | --- |
| `plugin_token` | `Authorization: Bearer <token>` | 识别调用方，用于路由、限流、日志归属 |
| `plugin_secret` | 不直接发送，用于计算签名 | 证明请求确实由持有密钥的人发出且未被篡改 |

两者缺一不可。只有 Token 而签名错误一律拒绝。

### 3.2 签名

除下载接口外，所有请求都要带这四个头：

```text
X-Plugin-Id    接入端标识
X-Timestamp    Unix 秒（UTC）
X-Nonce        单次随机值，建议 UUID v4
X-Signature    小写十六进制 HMAC-SHA256
```

签名原文按固定顺序用**换行符**拼接：

```text
signature = HMAC_SHA256(plugin_secret,
    METHOD + "\n" +
    PATH + "\n" +
    TIMESTAMP + "\n" +
    NONCE + "\n" +
    SHA256_HEX(BODY))
```

- `METHOD` 大写，如 `POST`
- `PATH` 含查询字符串、不含域名，如 `/api/v1/license/status?app_id=x&device_id=y`
- `BODY` 是原始请求体字节；GET 请求视为空字符串，`SHA256_HEX("")` 结果是
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

**三个最容易踩的坑：**

1. **查询串必须和实际发出的完全一致**，包括参数顺序和 URL 编码方式。
   拼一次字符串，签名和请求共用它，不要分别构造。
2. **对原始字节算哈希**，不要先反序列化再重新序列化——键顺序和空格都会变，签名就对不上了。
3. **重试时必须重新签名**，时间戳和 nonce 都要换新，否则会被判定为重放。

服务端校验顺序：插件状态 → 时间戳窗口（±300 秒）→ 签名 → nonce 去重。
签名先于 nonce 是有意的：验签失败不会消耗 nonce，你改对签名后可以用同一个 nonce 重试。

#### 测试向量

自己实现签名时，先用这组固定输入对答案。算不出同样的结果就不用往下调了。

```text
plugin_secret : sk_test_secret_for_cross_language_check
METHOD        : POST
PATH          : /api/v1/license/activate
TIMESTAMP     : 1787000000
NONCE         : fixed-nonce-abc-123
BODY          : {"app_id":"demo","license_key":"AAA-BBB","device_id":"dev-1"}
```

中间结果与最终签名：

```text
SHA256_HEX(BODY) = ae32ff194633e039c4cabf043aaf3a066e2c5f55b515e9ca6bddef5f51c06e34
signature        = 2c4a9525eea837122a2210b08a7a25c08827b0f7f040700763f53853584a6db5
```

Node.js、Python、PHP 三个 SDK 与服务端实现对这组输入产出的签名完全一致。

#### 各语言签名实现

<details>
<summary>C# / .NET（已有现成 SDK，这里仅供自行实现时参考）</summary>

```csharp
using System.Security.Cryptography;
using System.Text;

string Sign(string secret, string method, string path, string timestamp,
            string nonce, string body)
{
    var bodyHash = Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
    var payload = string.Join("\n", method.ToUpperInvariant(), path,
                              timestamp, nonce, bodyHash);
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    return Convert.ToHexString(
        hmac.ComputeHash(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();
}
```
</details>

<details>
<summary>Java</summary>

```java
String sign(String secret, String method, String path, String timestamp,
            String nonce, String body) throws Exception {
    MessageDigest sha = MessageDigest.getInstance("SHA-256");
    String bodyHash = HexFormat.of().formatHex(
        sha.digest(body.getBytes(StandardCharsets.UTF_8)));
    String payload = String.join("\n", method.toUpperCase(), path,
                                 timestamp, nonce, bodyHash);
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    return HexFormat.of().formatHex(
        mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
}
```
</details>

<details>
<summary>Go</summary>

```go
func sign(secret, method, path, timestamp, nonce, body string) string {
    sum := sha256.Sum256([]byte(body))
    payload := strings.Join([]string{
        strings.ToUpper(method), path, timestamp, nonce,
        hex.EncodeToString(sum[:]),
    }, "\n")
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(payload))
    return hex.EncodeToString(mac.Sum(nil))
}
```
</details>

### 3.3 接口

#### `POST /api/v1/license/activate` — 激活

```json
{
  "app_id": "my_app",
  "license_key": "VIP-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "device_id": "稳定设备指纹",
  "device_name": "张三的电脑",
  "client_version": "1.0.0",
  "channel": "stable"
}
```

成功返回：

```json
{
  "success": true,
  "license_id": "lic_xxx",
  "status": "active",
  "activated_at": "2026-08-19T01:00:00.000Z",
  "expires_at": "2026-09-18T01:00:00.000Z",
  "is_permanent": false,
  "device_limit": 2,
  "device_count": 1,
  "allow_rebind": true,
  "rebind_limit": 3,
  "rebind_remaining": 3,
  "offline_grace_hours": 48,
  "license_token": "eyJhbGci...",
  "token_expires_at": "2026-08-20T01:00:00.000Z",
  "policy": { }
}
```

同一设备重复激活是幂等的，不额外占用名额。

#### `POST /api/v1/license/verify` — 验证

请求体 `app_id`、`license_token`、`device_id`，可带 `client_version`、`channel`。

**每次验证都会换发新令牌**，请用返回的 `license_token` 覆盖你保存的那个。
这样单枚令牌的暴露窗口更短。

#### `POST /api/v1/license/deactivate` — 解绑

请求体 `app_id`、`license_token`（或 `license_key`）、`device_id`、`reason`。

这是「换绑」动作本身，会消耗一次换绑配额。配额用尽返回 `REBIND_LIMIT_EXCEEDED`，
需要联系管理员从后台强制解绑（管理员解绑默认不占用户配额）。

#### `GET /api/v1/license/status` — 状态查询

参数 `app_id` 加上 `license_id` 或 `license_key`，可选 `device_id`。

只返回状态，不签发令牌。**不能作为授权判断依据**，授权判断一律走 `verify`。

#### `GET /api/v1/license/policy` — 策略拉取

参数 `app_id`，可选 `client_version`、`device_id`、`channel`。

不需要卡密，未激活时也能调用。用于开机就问一句「我还能不能跑、要不要升级」。

这个接口**不做准入拦截**：应用被停用或远程关停时它依然返回 200，只在返回体里如实标注。
否则客户端会陷入「被拒绝了但不知道为什么」的死角，既无法向用户解释，也拿不到升级地址。

### 3.4 通用约定

- 时间统一 UTC ISO 8601，签名里的时间戳用 Unix 秒
- 错误响应统一为 `{ "code": "...", "message": "...", "request_id": "..." }`
- 所有响应都带 `X-Request-Id` 头，报障时提供它能直接定位服务端日志
- 写操作支持 `Idempotency-Key` 头，作用域是 `plugin_id + 接口 + 键`，保存 24 小时。
  同键同请求体返回首次结果；同键不同请求体返回 `IDEMPOTENCY_CONFLICT`
- 激活、验证、解绑接口按插件、设备、IP 多维度限流，触发时返回 `RATE_LIMITED` 并带 `Retry-After`

---

## 4. 错误码

**只能依赖 `code` 判断分支，不要匹配 `message`。** 文案会改，错误码不会。

| code | HTTP | 含义 | 建议动作 |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | 参数缺失或格式错误 | 不重试，检查代码 |
| `SIGNATURE_INVALID` | 401 | 签名或 Token 错误 | 不重试，检查密钥和签名实现 |
| `TIMESTAMP_EXPIRED` | 401 | 时间戳超出 ±300 秒 | 校准系统时间后重试一次 |
| `NONCE_REPLAYED` | 409 | 随机数重复 | 换 nonce 重试 |
| `TOKEN_INVALID` | 401 | 令牌非法、已撤销或与设备不匹配 | 清除本地令牌，重新激活 |
| `TOKEN_EXPIRED` | 401 | 令牌过期 | 重新调用 verify |
| `PLUGIN_DISABLED` | 403 | 接入端被停用或密钥已吊销 | 不重试，联系服务方 |
| `APP_MISMATCH` | 403 | 卡密不属于该应用 | 不重试 |
| `APP_DISABLED` | 403 | 应用已停用 | 不重试，联系服务方 |
| `APP_KILLED` | 403 | 应用被远程关停 | 不重试，展示服务端下发的提示语 |
| `APP_MAINTENANCE` | 503 | 维护中，暂停新激活 | 稍后重试 |
| `CLIENT_VERSION_TOO_LOW` | 426 | 版本低于最低要求 | 不重试，引导升级 |
| `LICENSE_NOT_FOUND` | 404 | 卡密不存在 | 提示用户检查输入 |
| `LICENSE_EXPIRED` | 403 | 卡密已过期 | 引导续费 |
| `LICENSE_BANNED` | 403 | 卡密已封禁 | 提示联系客服 |
| `LICENSE_REVOKED` | 403 | 卡密已作废 | 提示联系客服 |
| `LICENSE_NOT_ACTIVATED` | 403 | 卡密尚未激活 | 引导先激活 |
| `DEVICE_LIMIT_EXCEEDED` | 403 | 设备数已满 | 引导解绑其他设备 |
| `DEVICE_NOT_BOUND` | 404 | 该设备未绑定此卡密 | 引导重新激活 |
| `REBIND_NOT_ALLOWED` | 403 | 套餐不允许自助换绑 | 提示联系客服 |
| `REBIND_LIMIT_EXCEEDED` | 403 | 换绑次数用尽 | 提示联系客服 |
| `IDEMPOTENCY_CONFLICT` | 409 | 幂等键复用但请求体不同 | 不重试，属实现缺陷 |
| `RATE_LIMITED` | 429 | 触发限流 | 按 `Retry-After` 退避 |
| `INTERNAL_ERROR` | 500 | 服务端异常 | 指数退避，最多三次 |

**只有这四个值得重试**：`TIMESTAMP_EXPIRED`、`NONCE_REPLAYED`、`RATE_LIMITED`、`INTERNAL_ERROR`。
其余一律终止流程并给用户明确提示。

SDK 还会本地产生这几个（服务端不会返回）：`NETWORK_UNAVAILABLE`（网络不可达且超出宽限期）、
`NOT_ACTIVATED_LOCALLY`（本地无凭据）、`LOCAL_STORAGE_TAMPERED`（本地文件被改）。

---

## 5. 设备标识怎么定

`device_id` 是设备绑定的唯一依据，必须**稳定**且**能区分设备**。

**桌面应用**：SDK 会自动生成——机器固有特征（主机名、CPU、MAC）加一份持久化随机盐做哈希。
加盐是为了不把可反查的硬件信息送到服务端。盐文件丢失等同于换了台机器。

**网站后端**：由你决定，取决于「一个设备」在你的业务里是什么。

| 可以用 | 不要用 | 原因 |
| --- | --- | --- |
| 用户 ID / 账号 ID | IP 地址 | 换个 WiFi 就变 |
| 安装时生成并持久化的 UUID | User-Agent | 升级浏览器就变 |
| 客户端上报的机器码 | 会话 ID | 每次登录都变 |

用了不稳定的标识，用户会莫名其妙被判成新设备、吃掉设备名额，然后来找你投诉。

---

## 6. 离线宽限期

服务端按套餐下发 `offline_grace_hours`，客户端不能自己决定。

SDK 的行为：

1. 每次启动先尝试在线验证，成功则刷新令牌和宽限期起点
2. 网络不可用时，若距上次成功验证未超过宽限期，允许继续使用（结果里标 `offline: true`）
3. 超过宽限期一律拒绝——不会因为「可能只是网络问题」而放行
4. 授权本身已到期时，宽限期也不给续命

宽限期是对网络抖动的容忍，不是离线授权模式。**高价值功能不应受宽限期保护。**

套餐里把 `offline_grace_hours` 设为 0，就是要求每次启动必须联网。

---

## 7. 处理远程管控

每次 `verify` 和 `fetch_policy` 都会拿到最新策略。典型处理：

```python
def handle_policy(policy):
    # 公告
    if policy.get("notice"):
        show_notice(policy["notice"]["level"],
                    policy["notice"]["title"],
                    policy["notice"]["content"])

    upgrade = policy["upgrade"]
    if upgrade["required"]:
        # 不升级就不能继续用，必须阻断启动
        show_forced_upgrade(upgrade["latest_version"],
                            upgrade["download_url"],
                            upgrade["sha256"])
        raise SystemExit(1)
    elif upgrade["available"]:
        # 有新版但不强制，提示即可
        show_upgrade_hint(upgrade["latest_version"], upgrade["release_notes"])
```

服务端可能直接拒绝请求，这几个错误码是管控动作造成的，要给用户看清楚原因：

- `APP_KILLED` —— 应用被紧急关停，`message` 是后台配置的提示语，原样展示给用户
- `APP_MAINTENANCE` —— 维护中，只拦新激活，已激活设备的 `verify` 不受影响
- `CLIENT_VERSION_TOO_LOW` —— 版本过低，引导下载新版

下载安装包后**务必校验 SHA-256** 再执行，策略里的 `upgrade.sha256` 就是给这个用的。

---

## 8. 两种典型场景

### 8.1 桌面应用

```python
from jc_kami import LicenseClient, LicenseError, ErrorCode

client = LicenseClient(
    app_id="my_editor", server_url="https://license.example.com",
    plugin_id="my_editor_default",
    plugin_token=PLUGIN_TOKEN, plugin_secret=PLUGIN_SECRET,
    client_version=APP_VERSION, on_policy=handle_policy,
)

def startup():
    try:
        client.verify()
    except LicenseError as e:
        if e.code == ErrorCode.NOT_ACTIVATED_LOCALLY:
            key = prompt_for_license_key()
            try:
                client.activate(key)
            except LicenseError as ae:
                show_error(f"激活失败：{ae.message}")
                return False
        elif e.code == ErrorCode.DEVICE_LIMIT_EXCEEDED:
            show_error("设备数已满。可在其他设备上点「解绑本机」，或联系客服")
            return False
        elif e.code in (ErrorCode.LICENSE_EXPIRED, ErrorCode.LICENSE_BANNED,
                        ErrorCode.LICENSE_REVOKED, ErrorCode.APP_KILLED):
            show_error(e.message)
            return False
        else:
            show_error(f"[{e.code}] {e.message}\n请求 ID：{e.request_id}")
            return False
    return True
```

### 8.2 网站后端（PHP）

```php
// POST /api/activate —— 用户在你的网站上提交卡密
public function activate(Request $request)
{
    $userId = auth()->id();
    $device = LicenseClient::deviceIdFor('user:' . $userId);

    try {
        $result = $this->license->activate(
            $request->input('license_key'), $device, "用户 {$userId}"
        );
    } catch (LicenseError $e) {
        return response()->json([
            'ok'      => false,
            'code'    => $e->errorCode(),
            'message' => $e->getMessage(),
        ], 400);
    }

    // 令牌存进你自己的库，不要回传给浏览器
    UserLicense::updateOrCreate(
        ['user_id' => $userId],
        [
            'license_id'    => $result['license_id'],
            'license_token' => $result['license_token'],
            'expires_at'    => $result['expires_at'],
        ]
    );

    return response()->json(['ok' => true, 'expires_at' => $result['expires_at']]);
}

// 中间件：每次访问受保护功能时校验
public function handle($request, Closure $next)
{
    $record = UserLicense::where('user_id', auth()->id())->first();
    if (!$record) {
        return redirect()->route('license.activate');
    }

    try {
        $result = $this->license->verify(
            $record->license_token,
            LicenseClient::deviceIdFor('user:' . auth()->id())
        );
        // 令牌滚动续期，覆盖旧的
        $record->update(['license_token' => $result['license_token']]);
    } catch (LicenseError $e) {
        return redirect()->route('license.activate')
                         ->with('error', $e->getMessage());
    }

    return $next($request);
}
```

**注意**：不要在每个 HTTP 请求上都调 `verify`，那会让你的网站响应时间受授权中心影响。
实践做法是把验证结果缓存几分钟，或者只在关键操作前验证。

---

## 9. 安全须知

### plugin_secret 放在哪，决定了这套系统能防住什么

**服务端接入**（网站后端、API 服务）：密钥放服务器环境变量，客户端接触不到，
签名机制能真正防伪造。这是最推荐的接入方式。

**桌面 / 移动客户端接入**：密钥必然打包进客户端，可被逆向提取。这是客户端软件授权的
固有限制，任何方案都绕不过去，别信任何声称能解决的说法。此时签名的作用降级为
「抬高门槛 + 便于溯源」，真正的防线是服务端侧的手段：

- 设备绑定与数量限制
- 异常时封禁单张卡密
- 一键远程关停整个应用
- **把高价值功能放到服务端执行**——这条最有效

### 客户端上报的版本号是可以伪造的

`client_version` 由客户端自报，改过的客户端可以谎报版本绕过 `min_version` 检查。
版本策略的定位是「引导正常用户升级」，不是「阻止恶意用户」。

真正拦得住的只有 `kill_switch`（服务端直接拒绝，客户端伪造不了）和服务端侧的功能执行。

### 其他

- 生产环境必须全站 HTTPS
- 不要把 `plugin_secret` 提交进代码仓库，用环境变量或配置中心
- 不要在日志里打印卡密原文、令牌或完整设备指纹
- 密钥泄露时立即在后台轮换：签名密钥支持带宽限期轮换（新旧并存一段时间，方便分批更新），
  Token 轮换则立即生效

---

## 10. 常见问题

**Q：签名总是失败，怎么排查？**

按这个顺序查：

1. `PATH` 是否包含查询字符串，是否和实际请求的 URL 完全一致（含编码方式和参数顺序）
2. `BODY` 是否用的原始字节，有没有中途重新序列化过
3. 分隔符是不是 `\n`（换行符），不是 `|` 也不是空格
4. 时间戳是不是 Unix **秒**（不是毫秒），服务器时间有没有跑偏
5. 签名输出是不是**小写**十六进制

把签名原文打出来逐字段比对通常几分钟就能定位。

**Q：为什么每次 verify 返回的 token 都不一样？**

令牌滚动续期，缩短单枚令牌的暴露窗口。用新的覆盖旧的即可。旧令牌在自然过期前仍然有效，
真正的即时失效靠封禁、作废、解绑触发的撤销机制。

**Q：用户换电脑了怎么办？**

如果套餐允许换绑，让用户在旧设备上调 `deactivate`，然后在新设备上 `activate`。
旧设备已经开不了机的话，管理员可在后台「卡密详情 → 强制解绑」，默认不消耗用户的换绑配额。

**Q：设备指纹会变吗？**

桌面 SDK 的指纹依赖主机名、CPU、MAC 和本地盐文件。换主板网卡、重装系统会导致指纹变化，
等同于换了台机器。盐文件建议放在用户数据目录而不是临时目录。

**Q：能不能不用 SDK，直接发 HTTP？**

可以，协议全在第 3 节。SDK 只是帮你封装了签名、重试、离线宽限和错误码映射。

**Q：卡密丢了能找回明文吗？**

可以，但需要 `license:export` 权限，且每次导出都会记录操作者、时间、IP 和条数。
如果平台部署时选择了「生成后丢弃密文」，那就找不回来了，只能作废重发。

**Q：怎么验证我的接入是对的？**

仓库里有两份对着真实服务端跑的联调脚本，覆盖激活、验证、解绑、设备上限、幂等、
签名错误、网络中断、离线宽限、本地篡改等场景：

```bash
bash scripts/mint-test-licenses.sh
```

```bash
python3 packages/sdk-python/tests/integration_test.py
```

```bash
php packages/sdk-php/tests/integration_test.php
```

```bash
dotnet run --project packages/sdk-csharp/tests/JcKami.Sdk.IntegrationTests
```

脚本每次运行都会现发新卡、用随机设备标识，可以反复执行。
照着它们改一改，就能验证你自己那套实现。

**Q：一个应用能有多个接入端吗？**

能。Windows 客户端、网页后端、手机 App 各建一个接入端，各持一副独立密钥。
这样某个端的密钥泄露时可以单独停用它，其他端不受影响。
在后台的应用行点「接入凭据」即可添加。
