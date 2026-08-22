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

完整返回结构（`verify` 和 `activate` 返回体里的 `policy` 字段与此一致）：

```json
{
  "success": true,
  "policy": {
    "app_status": "active",            // active | disabled
    "kill_switch": false,              // true 表示已被远程关停
    "kill_message": null,              // 关停提示语，关停时才有值
    "maintenance": false,              // 维护模式
    "maintenance_message": null,
    "min_version": "1.0.0",            // 最低可用版本，null 表示不限制
    "upgrade": {
      "required": false,               // 为真则不升级不能继续用
      "available": true,               // 有新版可用
      "latest_version": "1.2.0",
      "message": null,                 // 后台配置的升级提示语
      "download_url": "https://…",
      "file_size": 55600000,
      "sha256": "…",
      "release_notes": "…",
      "mandatory": false,              // 该版本自身被标记为强制
      "package": { },                  // 安装方式，见 7.6
      "signature": "…"                 // Ed25519 签名，见 7.6
    },
    "notice": {                        // 未启用公告时为 null
      "level": "info",                 // info | warning | critical
      "title": "…",
      "content": "…"
    },
    "policy_ttl_seconds": 300,         // 建议的下次拉取间隔
    "server_time": "2026-08-22T05:43:26.958Z"
  }
}
```

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

每次 `verify`、`activate`、`fetch_policy` 都会带回最新策略，**所有判断都在服务端做完**，
客户端只负责执行。后台改了配置，客户端下次通信就生效，不用重新发版。

### 五种管控能力

| 能力 | 后台在哪开 | 客户端收到什么 | 你该做什么 |
|------|-----------|--------------|-----------|
| **远程关停** | 应用 → 远程管控 → 立即关停 | 请求直接被拒，`APP_KILLED` | 停止运行，原样展示 `message` |
| **维护模式** | 远程管控 → 维护中 | 新激活被拒 `APP_MAINTENANCE`；老设备 `verify` 照常 | 激活界面提示稍后再试 |
| **最低版本** | 远程管控 → 最低可用版本 | 版本过低直接被拒 `CLIENT_VERSION_TOO_LOW` | 引导下载新版 |
| **公告** | 远程管控 → 公告推送 | `policy.notice` 有值 | 按 `level` 分级展示 |
| **版本升级** | 版本发布 | `policy.upgrade` | 见 [7.6](#76-远程更新自动升级) |

**关停和维护的区别**：关停是紧急熔断，所有请求立即拒绝，已激活的用户也用不了；
维护只拦新卡激活，已激活设备不受影响——不至于让维护窗口内全员掉线。

### 公告怎么展示

`notice` 为 `null` 表示没有公告。有值时按 `level` 决定打扰程度：

| level | 含义 | 建议做法 |
|-------|------|---------|
| `info` | 普通通知 | 角落提示、状态栏，不打断操作 |
| `warning` | 警示 | 弹窗提示，可关闭 |
| `critical` | 重要 | 强提示，建议要求用户确认后才继续 |

同一条公告别反复弹。用 `title + content` 做个哈希记在本地，内容没变就不再打扰。

### 完整处理示例

```python
def handle_policy(policy):
    # 1. 公告：先展示，因为后面可能会阻断流程
    notice = policy.get("notice")
    if notice and not already_shown(notice):
        show_notice(notice["level"], notice["title"], notice["content"])
        mark_shown(notice)

    # 2. 关停：最高优先级，直接停
    if policy.get("kill_switch"):
        show_error(policy.get("kill_message") or "服务已停止")
        raise SystemExit(1)

    # 3. 升级
    upgrade = policy["upgrade"]
    if upgrade["required"]:
        # 不升级就不能用，必须阻断——但要把下载地址显示出来，别让用户卡死
        show_forced_upgrade(upgrade["latest_version"], upgrade["download_url"])
        raise SystemExit(1)
    elif upgrade["available"]:
        show_upgrade_hint(upgrade["latest_version"], upgrade["release_notes"])

    # 4. 按服务端建议的间隔安排下次拉取
    schedule_next_poll(policy.get("policy_ttl_seconds", 300))
```

### 拉取频率

`policy_ttl_seconds`（默认 300 秒）是服务端建议的间隔，**照着它来**，别自己写死更短的轮询——
会撞限流。启动时拉一次、之后按这个间隔拉，紧急关停最迟一个周期内生效。

### 被管控拒绝时的错误码

这几个错误码是管控动作造成的，要给用户看清原因，不要笼统报「网络错误」：

- `APP_KILLED` —— 已被远程关停，`message` 是后台配置的提示语，原样展示
- `APP_MAINTENANCE` —— 维护中，只拦新激活
- `CLIENT_VERSION_TOO_LOW` —— 版本过低，`details` 里带 `min_version`

下载安装包后**务必验签再执行**，只校验 SHA-256 是不够的：能替换安装包的人同样能替换哈希值。
完整做法见 [7.6 远程更新](#76-远程更新自动升级)。

---

## 7.5 次数卡（按次计费）

如果套餐配置了「每设备次数额度」，卡密就是次数卡：**每台设备有各自独立的次数**，用一次扣一次。
消费走**预扣-确认两阶段**，保证不多扣、不少扣、不超卖。

### 为什么要两阶段

单纯"调一次扣一次"有个问题：扣了之后你的业务如果失败了，那一次就白扣了。两阶段解决它：

```
reserve（预扣）  →  冻结 N 次额度，返回 reservation_id
执行你的业务
  成功  →  confirm（确认）  真正扣掉
  失败  →  release（释放）  退回额度
```

如果客户端在中间崩溃、没来得及 confirm/release，预扣会在 TTL 到期后**自动释放**，额度不会被永久占住。

### 接口

```
POST /api/v1/license/consume/reserve
  { app_id, license_token, device_id, amount=1, request_id, ttl_seconds }
  → { reservation_id, quota_available, ... }

POST /api/v1/license/consume/confirm
  { app_id, reservation_id }

POST /api/v1/license/consume/release
  { app_id, reservation_id }
```

### 三个正确性保证

- **幂等**：reserve 带 `request_id`，超时重试同一个值不会重复冻结；confirm 幂等，重试不会重复扣。
- **原子扣减**：额度不足时 reserve 直接返回 `QUOTA_EXHAUSTED`，并发下不会超卖（数据库层 `WHERE 可用 >= amount`）。
- **TTL 自动释放**：崩溃没确认的预扣会过期自动退回。

### SDK 用法（最省心）

SDK 封装了便捷的 `consume()`，自动处理 reserve → 业务 → confirm/release：

```js
// 业务成功自动 confirm 扣次；抛错自动 release 退回
const result = await client.consume(1, async () => {
  return await doExpensiveThing();   // 你的核心功能
});
```

也可以手动三步：

```js
const rsv = await client.reserve(1);       // 预扣
try {
  doWork();
  await client.confirm(rsv.reservation_id); // 成功确认
} catch {
  await client.release(rsv.reservation_id); // 失败退回
}
```

### 关键：consume 和 verify 是分开的

`verify` 只判断"还能不能用"，**不扣次数**，可以频繁调。次数消费必须显式调 `consume`/`reserve`，
在你"真正用掉一次功能"的时候。别把扣减放进启动校验里，否则每次开机都会误扣。

## 7.6 远程更新（自动升级）

平台负责三件事：**托管安装包、通知有新版、给包签名**。
真正把新版装上去由 SDK 完成，安装策略由发布时的配置决定。

### 核心思路：版本目录 + 指针切换

不要往正在运行的目录里解压——运行中的 exe 覆盖不了自己，解压到一半断电还会把用户的软件搞成半新半旧。
正确做法是每个版本独立成目录，用一个指针决定跑哪个：

```
YourApp/
├── launcher.exe        ← 小启动器，快捷方式指向它，本身几乎不用更新
├── current.txt         ← 内容是版本号，如 1.2.0
├── versions/
│   ├── 1.1.0/          ← 旧版留着，出问题可秒回滚
│   └── 1.2.0/app.exe   ← 新版
└── data/               ← 用户数据放外面，更新永不触碰
```

更新流程：下载 → 校验哈希 → **验签** → 解压到 `versions/新版本` → 改指针 → 重启。
任何一步失败，指针都没动，老版本照常能跑。

Chrome、VS Code、Discord 用的都是这个结构，不是我们发明的。

### 签名：为什么哈希不够

`upgrade.sha256` 只能防传输损坏，**防不了篡改**——哈希和安装包走同一条链路，能改包的人就能改哈希。
所以每个发布的版本都带一份 **Ed25519 签名**，签的是这串内容：

```
jc-kami-release-v1\n{app_id}\n{version}\n{sha256}\n{file_size}
```

连版本号一起签，是为了防「拿旧版本的合法签名冒充新版本」的回滚攻击。

私钥只存在服务端（加密存储，任何接口都不返回），公钥在后台
**应用 → 远程管控 → 更新验签公钥** 里复制。

> ⚠️ **公钥必须硬编码进客户端代码**。绝不能从服务器下载——那样篡改响应的人可以连公钥一起换掉，验签就完全失效了。这是整套机制的根基。

### 发布一个新版本

1. **改客户端里的版本号**再打包。服务端靠版本号比大小判断谁是旧版，不改号就不会提示更新。
2. 后台 **版本发布 → 新建版本**，上传安装包，填：
   - **版本号** —— 要比线上高
   - **包形态** —— PyInstaller `--onedir` 选「目录包」，`--onefile` 选「单文件」
   - **安装策略** —— 一般选「版本目录切换」
   - **剥掉外层目录** —— 压缩包里套了一层 `YourApp/` 就打开
   - **启动入口** —— `app.exe` / `main.js` / `index.php`
   - **强制升级 / 灰度放量** —— 按需
3. 点**发布**。这一刻服务端才生成签名，老客户端下次拉策略就能收到。

灰度建议：先放量 10%，观察一天没问题再拉到 100%。分桶按设备指纹算，同一台机器不会反复横跳。

### 策略里的更新信息

```json
"upgrade": {
  "available": true,           // 有新版
  "required": false,           // 为真则不升级就不给用
  "latest_version": "1.2.0",
  "download_url": "https://…/api/v1/releases/rel_xxx/download",
  "sha256": "…", "file_size": 55600000,
  "signature": "base64 签名",
  "package": {
    "type": "onedir",
    "install_strategy": "versioned",
    "strip_root_dir": true,
    "entry": "app.exe",
    "post_install": null
  }
}
```

### SDK 用法

四种语言接口一致，只是命名随各自习惯。

**Python**
```python
from jc_kami import LicenseClient, Updater

PUBLIC_KEY = "后台复制的公钥"   # 硬编码，不要从网络读

client = LicenseClient(app_id="myapp", server_url="https://auth.example.com", ...)
plan = client.check_update(current_version="1.1.0")

if plan.available:
    updater = Updater(root="D:/YourApp", public_key=PUBLIC_KEY)
    result = updater.apply(plan, progress=lambda got, total: print(f"{got}/{total}"))
    if result.applied:
        updater.restart()      # 启动 launcher 后自己退出
```

**Node**
```javascript
const plan = await client.checkUpdate('1.1.0');
if (plan.available) {
  const result = await new Updater({ root, publicKey: PUBLIC_KEY }).apply(plan);
}
```

**C#**
```csharp
var plan = await client.CheckUpdateAsync("1.1.0");
if (plan.Available) {
    var result = await new Updater(root, PublicKey).ApplyAsync(plan);
}
```

**PHP**（服务端场景，通常只准备不切换）
```php
$plan = $client->checkUpdate('1.1.0');
if ($plan->available) {
    // 下载+验签+解压到新版本目录，但不切指针
    $updater->stage($plan);
    // 指针切换交给部署脚本，避开正在处理的请求
}
```

SDK 内部做了这些，不用你操心：断点校验、sha256 比对、**验签失败拒装**、
路径穿越防护、原子切换、旧版本清理（默认保留 2 个可回滚）。

### Python + PyInstaller 实操

用 `--onedir`（启动快、将来能做增量更新）：

```bash
# 1. 打包主程序，版本号记得先改
pyinstaller --onedir --noconsole --name app main.py

# 2. 把 dist/app 目录打成 zip 上传（zip 里是单层 app/ 或直接平铺，两种都支持）
cd dist && zip -r YourApp-1.2.0.zip app
```

启动器只需打包一次，以后不用再动：

```bash
# 模板在 packages/sdk-python/templates/launcher.py
pyinstaller --onefile --noconsole --name launcher launcher.py
```

把 `launcher.exe` 放在应用根目录，用户的快捷方式指向它。它会读 `current.txt` 启动对应版本；
指针失效或那个版本坏了，会自动退到其他可用版本，不至于让用户面对一个打不开的软件。

### 签名保护到哪为止

签名覆盖的只有这四项：`app_id`、`version`、`sha256`、`file_size`。
换句话说，**安装包内容本身是不可篡改的**——包被换、版本被冒充、大小被改，验签都会失败。

但 `package` 里的安装参数（`entry`、`install_strategy`、`strip_root_dir`、`post_install`）
**不在签名范围内**。能篡改 policy 响应的人可以改动它们，所以 SDK 按"不可信输入"处理：

| 字段 | 被篡改的后果 | SDK 的防护 |
|------|-------------|-----------|
| `post_install` | 在用户机器上任意执行命令 | **默认不执行**，需显式开启 |
| `entry` | 写文件到目录外 | 只取文件名部分，丢掉路径 |
| `strip_root_dir` | 解压布局错乱 | 路径穿越防护兜底，最坏是装出来跑不了 |
| `install_strategy` | 跳过安装 | 属于拒绝服务，不造成越权 |

真正危险的只有 `post_install`，而它默认就是关的。

### 几个要留心的地方

- **`post_install` 默认不执行**。理由见上表：它不在签名保护内，开启等于允许服务端在用户机器上执行任意命令。确需使用请自行评估风险。
- **登记外部下载地址的版本拿不到签名**（服务端算不出哈希），SDK 会拒装。要用签名保护就把包传到平台。
- **用户数据别放版本目录里**，放 `data/` 或系统用户目录，否则更新后会"丢配置"。
- **强制升级要留退路**：`required` 为真时客户端应阻断启动，但要把下载地址显示出来，别让用户卡死。

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
