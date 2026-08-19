# 软件卡密平台开发文档

> 文档版本：v2.0　最后更新：2026-08-19　状态：第一版已实现，本文档与代码保持同步
>
> v2.0 依据实际实现回写：数据库改为 MySQL、前端改为 Vue，新增第 9 章「应用远程管控」，
> 并修正了签名校验顺序、卡密熵、换绑计数时机等若干与实现不一致的描述。

## 1. 项目目标

本项目是一个可扩展的软件授权与卡密销售平台。平台通过统一的授权中心管理应用、套餐、卡密、设备、订单和授权日志；新的软件或网站通过实现标准插件或接入 SDK，即可复用平台的收费和授权能力。

核心原则：

- 平台负责通用授权能力。
- 插件负责具体软件或网站的适配逻辑。
- SDK 负责降低客户端接入成本。
- 服务器负责最终授权判断。
- 插件不得直接修改平台核心代码。

## 2. 第一版交付范围

第一版优先完成以下闭环：

- 管理员登录、退出和权限校验。
- 应用的新增、编辑、启用和停用。
- 套餐的新增、编辑和授权规则配置。
- 卡密批量生成、搜索、导出、封禁和作废。
- 卡密激活、授权验证、设备绑定和设备解绑。
- 应用远程管控：一键关停、维护模式、最低版本限制、强制升级、公告下发。
- 版本发布：安装包托管、SHA-256 校验、按设备稳定分桶灰度放量。
- 授权日志、管理员操作日志和 API 请求日志。
- 标准 REST API。
- C# SDK，优先支持 Windows 软件接入。
- 插件开发规范和测试环境。

用户注册、在线支付、分销、多语言和更多语言 SDK 放在后续阶段。

## 3. 推荐技术栈

| 层级 | 推荐技术 | 说明 |
| --- | --- | --- |
| 管理后台 | Vue 3 + TypeScript + Vite | 管理员操作界面 |
| UI | Element Plus | 表格、表单和权限界面 |
| API 服务 | NestJS + TypeScript + Prisma | 模块化、适合插件和 SDK API |
| 数据库 | MySQL 8+ | 业务数据和审计数据 |
| 缓存 | Redis | 限流、短期令牌、并发控制 |
| 部署 | Docker + Nginx + Linux | 统一开发和生产环境 |
| 客户端 SDK | C#、Node.js、Python、Java | 按接入软件类型逐步增加 |

如果实际项目已有技术栈，应优先沿用已有技术栈，不为本系统额外引入重复框架。

## 4. 系统架构

```text
管理员后台 / 客户端 SDK / 插件服务
                |
                v
          API Gateway
                |
       +--------+---------+
       |                  |
 授权中心模块         销售与订单模块
       |                  |
       +--------+---------+
                |
       PostgreSQL + Redis
                |
       日志、Webhook、插件注册中心
```

### 4.1 核心模块

1. `auth`：管理员登录、角色、权限和会话。
2. `applications`：软件或网站应用管理。
3. `plans`：套餐和授权规则管理。
4. `licenses`：卡密生命周期和授权判断。
5. `devices`：设备绑定、换绑和并发控制。
6. `plugins`：插件注册、版本、配置和状态。
7. `orders`：订单、支付状态和发卡。
8. `audit`：管理员、登录、API 和授权日志。
9. `webhooks`：向已接入应用推送授权事件。

### 4.2 部署原则

插件代码不允许在主 API 进程中直接动态执行。推荐的插件形态是独立服务，通过内部 API 或标准 Webhook 与平台通信。第一版可以先采用“注册插件 + 配置适配器”的方式，插件经过审核后部署。

## 5. 角色与权限

### 超级管理员

拥有全部权限，包括管理员、应用、插件、安全设置和系统配置管理。

### 普通管理员

通过角色授予以下权限的组合：

- `application:read`、`application:write`
- `plan:read`、`plan:write`
- `license:read`、`license:write`
- `license:ban`、`license:unbind`
- `order:read`、`order:write`
- `plugin:read`、`plugin:write`
- `audit:read`

权限校验必须在服务端执行，前端隐藏按钮不能作为安全措施。

## 6. 应用与插件模型

### 6.1 应用字段

```text
id                 内部主键
app_id             对外唯一标识，例如 video_tool
name               应用名称
type               windows / android / web / api
status             active / disabled
current_version    当前应用版本
created_at         创建时间
updated_at         修改时间
```

### 6.2 插件字段

```text
id                 内部主键
plugin_id          对外唯一标识
application_id     所属应用
version            插件版本
runtime            sdk / http / webhook / service
endpoint           插件服务地址，可为空
status             draft / testing / active / disabled
config             加密后的插件配置
created_at         创建时间
updated_at         修改时间
```

一个应用可以绑定多个插件，例如 Windows、Android 和网站端分别使用不同插件。

**为什么要分两层。** 应用是你卖的那个产品，卡密、套餐、远程管控、版本发布都挂在它上面，只有一份；
插件是某一个接入端持有的一副钥匙。分开是为了让吊销的粒度小于整个产品——Windows 客户端的密钥被
逆向提取后，可以单独停用它，网页端和手机端用户完全不受影响，卡密一张不用动。顺带还能让日志按端
归因，以及分端灰度轮换密钥。

**但绝大多数应用只有一个接入端。** 所以后台把插件收进了应用详情页的「接入凭据」区块，不再作为
平级菜单；创建应用时默认顺手生成一副凭据并当场展示（`with_default_plugin`，默认 true，需要调用方
同时具备 `plugin:write` 权限）。单端接入一步到位，多端接入再到详情页里追加。

## 7. 卡密与授权规则

第一版支持以下卡密类型：

- 时间卡：激活后按天数计算到期时间。
- 永久卡：无固定到期时间，但可以被封禁或作废。
- 设备限制：限制一个卡密可以绑定的设备数量。

卡密状态：

```text
unused     未激活
active     已激活
expired    已过期
banned     已封禁
revoked    已作废
```

卡密使用密码学安全随机源生成。字符集为去除易混淆字符（0/O/1/I/L）后的 30 个符号，每字符约 4.9 位熵；默认 5 组 × 5 字符，约 122 位熵，后台可选 4 组（约 98 位）、5 组或 6 组（约 147 位）。生成使用拒绝采样，避免直接取模造成字符分布偏斜。存储采用多列方案，避免“只保存哈希”与“支持搜索、导出明文”互相矛盾：

```text
key_hash      卡密全文的 HMAC-SHA256（服务端 pepper），唯一索引，激活时精确查找与校验
key_cipher    卡密全文的 AES-256-GCM 密文，密钥由 KMS 或独立密钥服务管理并支持轮换，仅用于导出
key_masked    脱敏展示值，例如 ABCD-****-****-1234，后台列表默认展示
key_prefix    卡密前若干位明文，建立索引，供后台按前缀搜索
```

后台列表与搜索只读取 `key_masked` 和 `key_prefix`，不做解密。解密 `key_cipher` 只允许发生在导出场景，必须校验高权限、限制单次导出条数，并写入审计日志（操作者、时间、来源 IP、导出条数、批次号）。如果业务上不需要事后导出，可在批量生成时一次性返回明文并丢弃 `key_cipher`，此时后台只能看到脱敏值。

套餐至少包含：

```text
name               套餐名称
duration_days      授权天数，永久卡为空
device_limit       最大设备数
allow_rebind       是否允许换绑
rebind_limit       换绑次数
price              销售价
status             active / inactive
offline_grace_hours 离线宽限小时数，0 表示必须在线验证
```

字段语义：`duration_days` 为空表示永久卡；`allow_rebind` 为 false 时忽略 `rebind_limit`；`allow_rebind` 为 true 且 `rebind_limit` 为空表示不限换绑次数。

换绑次数在**解绑时**计数，而不是在绑定新设备时。理由是解绑才是用户主动发起的那一次「换机器」动作，
在这里扣配额语义最清晰：配额限制的是「把授权从一台机器上摘下来」的次数，之后绑到新机器属于正常绑定，
不再重复扣减。上限用尽后 `deactivate` 返回 `REBIND_LIMIT_EXCEEDED`，需要联系客服由管理员强制解绑。
管理员强制解绑默认不计入用户配额（可通过 `count_as_rebind` 显式计入），属于客服兜底手段。

## 8. 标准 API

所有生产 API 必须使用 HTTPS，并以 `/api/v1` 作为版本前缀。

### 8.1 管理员登录

```http
POST /api/v1/admin/auth/login
Content-Type: application/json
```

```json
{
  "username": "admin",
  "password": "password"
}
```

返回短期 access token 和可轮换的 refresh token。密码使用 Argon2id 或 bcrypt 哈希保存。

### 8.2 激活卡密

```http
POST /api/v1/license/activate
Authorization: Bearer <plugin-token>
Content-Type: application/json
```

```json
{
  "app_id": "video_tool",
  "license_key": "XXXX-XXXX-XXXX",
  "device_id": "stable-device-fingerprint",
  "client_version": "1.0.0"
}
```

时间戳与随机数由 8.7 定义的签名请求头携带，不放在请求体内。

成功响应：

```json
{
  "success": true,
  "license_id": "lic_123",
  "status": "active",
  "expires_at": "2026-09-18T12:00:00Z",
  "device_limit": 1,
  "offline_grace_hours": 72,
  "license_token": "signed-license-token",
  "token_expires_at": "2026-08-20T12:00:00Z",
  "request_id": "req_01H..."
}
```

`license_token` 是服务端签发的短期授权令牌，`verify` 和 `deactivate` 全流程使用同一名称。客户端只做透传和本地存储，不解析、不修改、不据此自行判断授权是否有效。

### 8.3 验证授权

```http
POST /api/v1/license/verify
Authorization: Bearer <plugin-token>
Content-Type: application/json
```

请求体至少包含 `app_id`、`license_token` 和 `device_id`，时间戳与随机数由 8.7 的签名请求头携带。服务端重新判断卡密状态、应用归属、设备限制和到期时间，不仅信任客户端传回的状态。

验证通过时返回新的 `license_token` 和 `token_expires_at`，实现令牌滚动续期，客户端应覆盖本地缓存。

### 8.4 解绑设备

```http
POST /api/v1/license/deactivate
Authorization: Bearer <plugin-token>
```

请求体至少包含 `app_id`、`license_token` 或 `license_key`、`device_id` 和 `reason`。解绑必须校验卡密、应用、设备和换绑权限，成功后立即撤销该设备已签发的令牌，并记录操作者、来源 IP 和原因。

### 8.5 状态查询

```http
GET /api/v1/license/status?app_id=video_tool&license_id=lic_123
Authorization: Bearer <plugin-token>
```

支持用 `license_id` 或 `license_key` 定位，可选带 `device_id` 以获知本机是否已绑定。只返回状态、到期时间、已绑定设备数和设备上限，不返回卡密明文、完整设备指纹和授权令牌。该接口用于后台或客户端展示，不能作为授权判断依据，授权判断一律走 8.3。

### 8.6 API 通用约定

- 时间统一使用 UTC ISO 8601，令牌与签名中的时间戳使用 Unix 秒。
- 所有写操作支持幂等键 `Idempotency-Key`。幂等作用域是 `plugin_id + 接口 + 幂等键`，记录至少保存 24 小时；同键同请求体直接返回首次结果，同键不同请求体返回 `IDEMPOTENCY_CONFLICT`。
- 错误响应统一为 `{ "code": "LICENSE_EXPIRED", "message": "...", "request_id": "..." }`，`request_id` 必须与服务端日志可对应。
- 客户端不得依赖中文错误文案判断逻辑，应根据 `code` 判断，`code` 清单见 8.8。
- 激活、验证和登录接口必须限流，建议按插件、卡密、设备和来源 IP 四个维度分别计数，触发时返回 `RATE_LIMITED` 并携带 `Retry-After`。
- 所有接口响应都返回 `X-Request-Id`，SDK 在报错时应把该值透出，便于排查。

### 8.7 请求签名与防重放

除管理员登录外，所有插件侧接口都必须签名。插件 Token 与签名各司其职：`Authorization: Bearer <plugin-token>` 用于识别调用方并做路由与限流，签名用于证明请求确实由持有密钥的插件发出且未被篡改，两者缺一不可，只有 Token 而签名错误一律拒绝。

签名参数放在请求头，不放在请求体，避免与业务字段混在一起：

```text
X-Plugin-Id    插件对外标识
X-Timestamp    Unix 秒，UTC
X-Nonce        单次随机值，建议 UUID v4
X-Signature    小写十六进制 HMAC-SHA256
```

签名原文按固定顺序拼接，字段之间用换行符分隔：

```text
signature = HMAC_SHA256(plugin_secret,
    method + "\n" +
    path + "\n" +
    timestamp + "\n" +
    nonce + "\n" +
    SHA256_HEX(body))
```

`method` 为大写动词，`path` 含查询字符串且不含域名，GET 请求的 `body` 视为空字符串。服务端校验顺序：

1. 插件存在，状态为 `active` 或 `testing`（`draft` 与 `disabled` 一律拒绝），且 Token 匹配。
2. `X-Timestamp` 与服务端时间差不超过 300 秒。
3. 签名使用常量时间比较，失败不返回任何关于差异的细节。
4. **签名通过后**才把 `X-Nonce` 以 `nonce:{plugin_id}:{nonce}` 为键写入 Redis，TTL 与时间窗一致，键已存在即判定重放。

第 3 步和第 4 步的顺序是有意为之：先验签能让未持有密钥的请求完全不接触 Redis，
既避免 nonce 空间被无成本刷爆，也避免合法客户端在签名失败后重试时，被自己上一次
请求写入的 nonce 挡住。

Token 与签名失败都统一返回 `SIGNATURE_INVALID`，不区分是哪一项出错，避免把线索泄露给攻击方。

密钥轮换期间允许同时校验新旧两把密钥，旧密钥设置明确的下线时间。

### 8.8 标准错误码

`code` 是客户端唯一可依赖的判断依据，一经发布不得修改语义，只能追加新值。

| code | HTTP | 含义 | SDK 建议动作 |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | 参数缺失或格式错误 | 不重试，报错 |
| `SIGNATURE_INVALID` | 401 | 签名校验失败 | 不重试，检查密钥 |
| `TIMESTAMP_EXPIRED` | 401 | 时间戳超出允许窗口 | 校时后重试一次 |
| `NONCE_REPLAYED` | 409 | 随机数重复 | 换 nonce 重试 |
| `TOKEN_INVALID` | 401 | 授权令牌非法或已撤销 | 清除本地令牌，重新激活 |
| `TOKEN_EXPIRED` | 401 | 授权令牌过期 | 重新调用 verify |
| `PLUGIN_DISABLED` | 403 | 插件停用或密钥已吊销 | 不重试，提示联系服务方 |
| `APP_MISMATCH` | 403 | 卡密不属于该应用，或插件越权操作别的应用 | 不重试 |
| `APP_DISABLED` | 403 | 应用已停用 | 不重试，提示联系服务方 |
| `APP_KILLED` | 403 | 应用被远程关停 | 不重试，展示服务端下发的提示语 |
| `APP_MAINTENANCE` | 503 | 维护中，暂停新激活 | 稍后重试 |
| `CLIENT_VERSION_TOO_LOW` | 426 | 客户端版本低于最低要求 | 不重试，引导升级 |
| `LICENSE_NOT_FOUND` | 404 | 卡密不存在 | 不重试 |
| `LICENSE_EXPIRED` | 403 | 卡密已过期 | 引导续期 |
| `LICENSE_BANNED` | 403 | 卡密已封禁 | 不重试 |
| `LICENSE_REVOKED` | 403 | 卡密已作废 | 不重试 |
| `LICENSE_NOT_ACTIVATED` | 403 | 卡密尚未激活 | 引导先激活 |
| `DEVICE_LIMIT_EXCEEDED` | 403 | 超出设备数量限制 | 引导解绑 |
| `DEVICE_NOT_BOUND` | 404 | 设备未绑定该卡密 | 不重试 |
| `REBIND_NOT_ALLOWED` | 403 | 套餐不允许换绑 | 不重试 |
| `REBIND_LIMIT_EXCEEDED` | 403 | 换绑次数用尽 | 不重试 |
| `IDEMPOTENCY_CONFLICT` | 409 | 幂等键复用但请求体不同 | 不重试，属实现缺陷 |
| `RATE_LIMITED` | 429 | 触发限流 | 按 `Retry-After` 退避 |
| `INTERNAL_ERROR` | 500 | 服务端异常 | 指数退避，最多三次 |

对客户端而言，只有 `TIMESTAMP_EXPIRED`、`NONCE_REPLAYED`、`RATE_LIMITED` 和 `INTERNAL_ERROR` 属于可重试错误，其余一律终止流程并展示提示。

管理端接口另有一组错误码，客户端 SDK 不会遇到：`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、
`CONFLICT`、`BAD_CREDENTIALS`、`ACCOUNT_LOCKED`（HTTP 423）、`ACCOUNT_DISABLED`、`PERMISSION_DENIED`。

### 8.9 策略拉取

```http
GET /api/v1/license/policy?app_id=video_tool&client_version=1.2.0&device_id=<指纹>&channel=stable
Authorization: Bearer <plugin-token>
```

不携带卡密的纯策略查询，供客户端在启动时（甚至尚未激活时）先问一句「我还能不能跑、要不要升级」。
返回体见第 9 章。

这个接口**有意不做准入拦截**：应用被停用或远程关停时它依然返回 200，只是在返回体里如实标注
`app_status`、`kill_switch` 和提示语。否则客户端会陷入「被拒绝了但不知道为什么」的死角，
无法向用户解释，也拿不到升级地址。真正的拦截发生在 `activate` 与 `verify`。

### 8.10 Webhook 推送

平台向已接入应用推送授权事件，第一版事件类型：

```text
license.activated        卡密激活成功
license.expired          卡密到期
license.banned           卡密被封禁
license.revoked          卡密被作废
license.device_bound     设备绑定
license.device_unbound   设备解绑
order.paid               订单支付完成
```

推送为 POST JSON，请求头包含 `X-Event-Id`、`X-Event-Type`、`X-Timestamp` 和 `X-Signature`，签名算法与 8.7 一致，密钥为该应用独立的 webhook secret。

接收方必须按 `X-Event-Id` 做幂等去重，同一事件可能被投递多次。接收方需在 5 秒内返回 2xx，超时或非 2xx 视为失败，按 1 秒、5 秒、30 秒、2 分钟、10 分钟、1 小时退避重试，最多 6 次；全部失败后进入死信队列并在后台告警。事件体不包含卡密原文，只包含 `license_id`、`app_id`、状态和时间。

## 9. 应用远程管控

统一管理多个软件的价值，一半在发卡，另一半在「出了事能立刻按下去」。
本章描述平台如何在不重新发布客户端的前提下，远程控制某个应用的运行状态与版本。

所有管控决策都在服务端做出，客户端只负责执行。客户端每次调用 `verify` 都会收到最新策略，
未激活时也可以通过 8.9 的策略接口单独拉取。

### 9.1 管控手段

| 手段 | 字段 | 生效范围 | 典型场景 |
| --- | --- | --- | --- |
| 应用停用 | `status` | 激活与验证全部拒绝 | 产品下线 |
| 紧急熔断 | `kill_switch` | 激活与验证全部拒绝，可自定义提示语 | 发现严重漏洞、盗版泛滥 |
| 维护模式 | `maintenance` | 只拒绝新设备激活，已激活设备照常验证 | 数据库维护窗口 |
| 最低版本 | `min_version` | 低于该版本的客户端一律拒绝 | 旧版存在安全问题 |
| 强制升级 | `force_upgrade` | 有新版时标记为必须升级 | 协议不兼容 |
| 公告 | `notice_*` | 随策略下发，不影响可用性 | 停服预告、活动通知 |

维护模式与熔断的区别值得强调：**熔断会让所有在跑的客户端立刻停下，维护模式不会**。
维护窗口内如果把已激活设备也一并拒掉，等于每次维护都要让全体用户掉线，
所以 `maintenance` 只拦 `activate`，`verify` 照常放行。

### 9.2 策略下发格式

```json
{
  "app_status": "active",
  "kill_switch": false,
  "kill_message": null,
  "maintenance": false,
  "maintenance_message": null,
  "min_version": "1.1.0",
  "upgrade": {
    "required": false,
    "available": true,
    "latest_version": "2.0.0",
    "message": "修复了若干安全问题",
    "download_url": "https://license.example.com/api/v1/releases/rel_xxx/download",
    "file_size": 52428800,
    "sha256": "1a6de796...",
    "release_notes": "全新架构",
    "mandatory": true
  },
  "notice": { "level": "warning", "title": "今晚维护", "content": "23:00-24:00" },
  "policy_ttl_seconds": 300,
  "server_time": "2026-08-19T01:00:00Z"
}
```

`upgrade.required` 为真表示不升级就不能继续使用，客户端应当阻断启动流程；
`upgrade.available` 为真但 `required` 为假时，只提示不阻断。

### 9.3 版本发布与灰度

安装包可以上传到平台托管，也可以只登记外部下载地址（自建 CDN、对象存储）。
上传时服务端计算 SHA-256 并随策略下发，客户端下载后应校验后再执行。

版本有三种状态：`draft`（新建默认，不下发）、`published`（按放量比例下发）、`archived`（不再下发）。
必须显式发布才会到达客户端，避免误传的包被立刻推出去。

灰度按 `rollout_percent` 放量，分桶方式是 `SHA256(release_id + ':' + device_id)` 取模 100：

- 同一设备在放量比例不变时永远落在同一个桶，不会出现「刷新一下提示升级、再刷新又不提示」的抖动。
- 不同版本用不同的 `release_id` 做种子，所以一台设备不会因为在上个版本里中签就总是中签。
- 未命中灰度的设备回退到最近一个 100% 放量的版本，不会出现「什么版本都拿不到」的空档。

### 9.4 客户端版本是自报的

`client_version` 由客户端自己上报，被改过的客户端可以谎报版本绕过 `min_version` 检查。
这是客户端侧鉴权无法回避的固有限制，不要把它当成安全边界。

真正可靠的手段只有两个：`kill_switch` 立即断供（服务端拒绝，客户端伪造不了），
以及把高价值功能放到服务端执行。版本策略的定位是「引导正常用户升级」，不是「阻止恶意用户」。

## 10. SDK 接入规范

SDK 应提供统一的最小接口：

```csharp
var client = new LicenseClient(new LicenseOptions
{
    AppId = "video_tool",
    ServerUrl = "https://license.example.com",
    PluginToken = "plugin-token"
});

var result = await client.ActivateAsync(licenseKey, deviceId);

if (!result.Success)
{
    // 根据 result.Code 展示错误或退出应用
}
```

SDK 应负责：

- 生成或接收稳定的设备标识。
- 请求签名、时间戳和随机数。
- 激活与验证请求。
- 授权令牌本地安全存储。
- 网络超时和有限次数重试。
- 离线宽限期控制。
- 将服务端错误转换为稳定错误码。

SDK 不应负责最终授权决策，也不应在客户端硬编码卡密或应用密钥。高价值功能应在服务端再次验证授权。

### 10.1 授权令牌与离线宽限期

`license_token` 默认有效期 24 小时，最长不超过 7 天。令牌载荷至少包含 `license_id`、`app_id`、`device_id`、`plan_id`、`issued_at`、`expires_at` 和 `jti`，使用服务端密钥签名。撤销通过令牌撤销表或卡密上的 `token_version` 实现：卡密被封禁、作废、到期或设备被解绑时，已签发令牌立即失效，不等自然过期。

离线宽限期由服务端下发，不由客户端自行决定，字段为套餐上的 `offline_grace_hours`，默认 72 小时，可配置为 0 表示必须在线验证。SDK 的行为约定：

- 每次启动先尝试在线 `verify`，成功则刷新本地令牌和宽限期起点。
- 网络不可用时，若距上次成功验证未超过 `offline_grace_hours`，允许继续使用。
- 超过宽限期一律拒绝，不因为“可能是网络问题”而放行。
- 本地令牌与上次验证时间必须防篡改存储（签名或加密），不得使用可直接编辑的明文配置。

宽限期是对网络抖动的容忍，不是离线授权模式。高价值功能不应受宽限期保护。

## 11. 插件开发流程

1. 管理员在后台创建应用并获取 `app_id`。
2. 创建插件并指定运行方式、版本和回调地址。
3. 生成独立的插件 Token 或签名密钥。
4. 使用对应语言 SDK，或按照 API 文档实现 HTTP 适配。
5. 在测试环境完成激活、验证、过期、封禁和换绑测试。
6. 提交插件版本，记录变更说明和所需配置。
7. 审核通过后发布为 `active`。
8. 通过版本号和灰度策略升级插件。

插件必须具备健康检查、超时处理和结构化日志。插件配置中的密钥必须加密保存，日志中不得输出卡密原文、Token 或完整设备指纹。

## 12. 数据库核心表

```text
admin_users          管理员
admin_roles          角色
admin_user_roles     管理员角色关系
applications         应用
application_plugins  插件
plans                套餐
license_keys         卡密
license_activations  激活记录
license_devices      设备绑定
users                客户用户
orders               订单
payments             支付记录
api_keys             应用或插件密钥
plugin_configs       插件配置
license_key_exports  卡密导出批次
license_token_revocations  已撤销的授权令牌
app_releases         版本发布与安装包托管
idempotency_records  幂等键与首次响应
webhook_endpoints    应用 Webhook 地址与密钥
webhook_deliveries   Webhook 投递与重试记录
audit_logs           管理员操作日志
login_logs           登录日志
api_request_logs     API 请求日志
```

关键约束：

- `applications.app_id`、`application_plugins.plugin_id` 和 `license_keys.key_hash` 建立唯一索引。
- `license_devices` 对 `(license_id, device_id)` 建立唯一约束，激活在事务内完成，避免并发请求重复绑定或超出设备上限。
- `idempotency_records` 对 `(plugin_id, endpoint, idempotency_key)` 建立唯一索引。
- `webhook_deliveries` 对 `(endpoint_id, event_id)` 建立唯一索引，保证同一事件不会重复入队。
- `app_releases` 对 `(application_id, version, channel)` 建立唯一索引，同一通道下版本号不可重复。

nonce 记录和限流计数只放 Redis，不入库。`api_request_logs`、`webhook_deliveries` 和 `idempotency_records` 增长快，需要按时间分区并配置定期归档或清理策略。

## 13. 安全要求

- 全站 HTTPS，生产环境禁止明文 HTTP 传输敏感数据。
- 管理员密码使用 Argon2id 或 bcrypt，不保存明文密码。
- 管理员后台支持二次验证和登录失败锁定。
- 应用和插件使用独立密钥，支持吊销和轮换。
- 插件侧接口一律签名，时间戳窗口 300 秒，nonce 在窗口内不可重复，具体规则见 8.7。
- 对登录、激活、验证和管理 API 分别限流。
- 卡密以 `key_hash` 校验、`key_cipher` 加密存储，后台默认只展示脱敏值；导出明文需要高权限、限制单批数量并写入审计日志。
- 设备指纹只保存必要信息，并进行脱敏或哈希处理。
- 支付发卡只允许由服务端签名回调触发。
- 所有封禁、作废、解绑和密钥变更都必须记录审计日志。
- 插件不能直接执行后台上传的任意代码，推荐独立服务部署。
- 授权令牌使用签名机制并设置过期时间；封禁、作废、到期和解绑必须立即撤销已签发令牌，不能等其自然过期。
- 服务端时钟需要 NTP 同步，时间漂移会直接导致签名校验和令牌判断出错。

客户端代码无法做到绝对不可破解。对于高价值软件，关键业务判断必须放到服务器端，并采用定期在线验证和短期授权令牌。

## 14. 测试要求

端到端测试位于 `packages/server/test/platform.e2e-spec.ts`，跑在独立的 `jc_kami_test` 库上：

```bash
pnpm --filter @jc-kami/server test:e2e
```

当前 72 个用例全部通过，覆盖下列全部场景：

- 正常登录、错误密码、登录限流和 Token 过期。
- 未激活卡密激活成功。
- 已激活、过期、封禁、作废卡密被正确拒绝。
- 错误应用使用卡密被拒绝。
- 超过设备数量被拒绝。
- 并发激活不会产生重复设备绑定。
- 允许换绑和达到换绑上限的行为正确。
- 重复请求使用幂等键不会重复创建授权。
- 时间戳过期、nonce 重复和签名错误被拒绝。
- 插件停用后请求不能继续授权。
- 密钥吊销后旧签名立即失效，轮换期内新旧密钥都可用。
- 卡密封禁、作废或设备解绑后，已签发的授权令牌立即失效。
- 令牌过期后 verify 返回 `TOKEN_EXPIRED`，续期后可继续使用。
- 离线宽限期内允许使用，超过宽限期被拒绝，`offline_grace_hours` 为 0 时必须在线验证。
- 本地令牌被篡改后 SDK 判定为无效并要求重新激活。
- 低权限管理员无法导出明文卡密，导出成功时必须产生审计日志。
- Webhook 重复投递同一 `X-Event-Id` 不会被重复处理，失败按退避策略重试并最终进入死信队列。
- 管理员无权限时无法执行高风险操作。
- 支付回调重复发送不会重复发卡。
- 每种错误码都有对应的用例，返回的 `code` 与 8.8 表格一致。
- 应用停用、远程关停、维护模式、最低版本限制各自返回正确错误码。
- 灰度分桶稳定：同一设备多次请求拿到同一版本。
- 布尔字段传字符串 `"false"` 不会被误判为 `true`。
- 卡密明文不出现在列表接口、数据库脱敏列和任何日志中。

支付回调相关用例待第四阶段实现销售系统后补充。

## 15. 开发阶段

### 阶段一：授权核心

管理员登录、应用、套餐、卡密、激活 API、验证 API、设备绑定和日志。签名与防重放（8.7）、标准错误码（8.8）和授权令牌撤销（10.1）属于授权核心，必须在阶段一完成，不能推迟到后续阶段补做。Webhook（8.10）可以延后到阶段三，但事件类型和签名方式在阶段一先定下来，避免后续改动破坏已接入的插件。

### 阶段二：后台完善

批量操作、导出、权限管理、封禁、续期、设备解绑和统计面板。

### 阶段三：插件与 SDK

插件注册、版本管理、测试环境、C# SDK、Node.js SDK 和插件开发示例。

### 阶段四：销售系统

客户用户、商品页、订单、支付回调、自动发卡、退款和售后。

### 阶段五：平台化能力

多租户、代理商、分销、子管理员、独立品牌域名、多语言和多币种。

## 16. 验收标准

第一版完成后，管理员应能在后台完成“创建应用 -> 创建套餐 -> 批量生成卡密 -> 查看卡密 -> 封禁或解绑”；一个 Windows 软件应能通过 C# SDK 完成“输入卡密 -> 激活设备 -> 启动时验证 -> 到期后拒绝使用”的完整流程。新增软件只需创建应用、注册插件并按本文档接入，不得修改授权核心模块。
