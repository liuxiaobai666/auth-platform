# 软件卡密平台

一套可复用的软件授权与卡密销售平台。新软件只需在后台创建应用、注册插件，
接入 SDK 即可获得发卡、激活、设备绑定、远程升级与远程关停能力，无需改动授权核心。

设计文档见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 能做什么

- **统一发卡**：批量生成卡密，支持时间卡与永久卡、设备数限制、换绑次数限制。
- **授权校验**：签名防伪、时间戳与 nonce 防重放、设备指纹绑定、短期授权令牌与即时撤销。
- **远程管控**：一键关停某个应用、维护模式、限制最低可用版本、强制升级、下发公告。
- **版本发布**：上传安装包、SHA-256 校验、按设备稳定分桶灰度放量。
- **可追溯**：授权流水、管理员操作、登录记录、API 调用四类日志，卡密明文导出全程留痕。

## 目录结构

```text
packages/
  server/          NestJS + Prisma + MySQL 授权中心（API 服务）
  admin/           Vue 3 + Element Plus 管理后台
  sdk-node/        Node.js 客户端 SDK
  sdk-python/      Python 客户端 SDK（零依赖）
  sdk-php/         PHP 客户端 SDK（面向网站后端）
  sdk-csharp/      C# 客户端 SDK（Windows 桌面，兼容 .NET Framework）
  example-client/  接入示例，可直接跑通完整流程
docs/
  INTEGRATION.md   接入指南：协议规范、SDK 用法、错误码、常见问题
```

## 快速开始

### 1. 环境要求

- Node.js ≥ 20.11
- MySQL ≥ 8.0
- Redis ≥ 6（用于 nonce 防重放与限流）
- pnpm ≥ 9

### 2. 安装与建库

```bash
pnpm install
```

```bash
mysql -u root -e "CREATE DATABASE jc_kami DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

复制并按需修改服务端配置：

```bash
cp packages/server/.env.example packages/server/.env
```

**上线前必须更换 `.env` 里的全部密钥**，尤其是：

| 变量 | 说明 |
| --- | --- |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | 管理员登录令牌签名密钥 |
| `LICENSE_TOKEN_SECRET` | 授权令牌签名密钥 |
| `LICENSE_KEY_PEPPER` | 卡密哈希盐。**一旦有卡密生成就不能再改**，改了所有卡密都无法校验 |
| `MASTER_ENCRYPTION_KEY` | 卡密与插件密钥的加密主密钥，必须是 64 位十六进制 |

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. 初始化数据库

```bash
pnpm db:migrate && pnpm db:seed
```

seed 会创建三个内置角色和超级管理员，默认账号 `admin` / `Admin@123456`，**登录后请立即改密**。

### 4. 启动

```bash
pnpm dev:server
```

```bash
pnpm dev:admin
```

后台地址 http://localhost:5273 ，API 地址 http://localhost:3100 。

### 5. 跑一遍完整流程

后台里依次操作：**创建应用（会当场弹出接入凭据，请保存）→ 创建套餐 → 生成卡密**。

> 「应用」和「接入端凭据」是两层：应用是你卖的产品，卡密与远程管控挂在它上面；
> 凭据是某一个接入端持有的钥匙，分开是为了让吊销粒度小于整个产品。
> 单端接入用创建应用时自动生成的那副即可；多端接入在应用行的「接入凭据」里继续追加。

然后配置示例客户端：

```bash
cp packages/example-client/.env.example packages/example-client/.env
```

把插件页面拿到的 `plugin_id` / `plugin_token` / `plugin_secret` 填进去，再执行：

```bash
cd packages/example-client && node src/cli.js activate <你的卡密>
```

```bash
cd packages/example-client && node src/cli.js run
```

此时回到后台「应用管理 → 远程管控」打开一键关停，再执行一次 `run`，客户端会立刻拒绝启动。

## 接入你自己的项目

完整说明见 **[接入指南 docs/INTEGRATION.md](docs/INTEGRATION.md)**，包含协议规范
（任何语言都能照着自己实现）、错误码清单、桌面应用与网站后端两种场景的完整代码。

管理后台里也内置了**「接入文档」页**：选一个应用即可看到填好该应用 app_id 的四语言 SDK
示例、签名规则与错误码表，还能在线发真实请求测试接口（签名由服务端完成，密钥不经过浏览器）。
把这一页连同应用的接入凭据交给对接人，对方即可开始接入。

现成 SDK：

| 语言 | 安装 | 适用 |
| --- | --- | --- |
| Node.js | `pnpm add @jc-kami/sdk` | 桌面（Electron）与服务端 |
| Python | `pip install ./packages/sdk-python` | 桌面工具与服务端，零依赖 |
| PHP | `composer require jc-kami/sdk` | 网站后端 |
| C# / .NET | 引用 `packages/sdk-csharp` 项目 | Windows 桌面，兼容 .NET Framework 4.6.1+ |

没有对应 SDK 的语言（Java、Go 等），照着接入指南第 3 节的协议自己实现即可，
文档里给了各语言的签名代码片段和一组测试向量用来对答案。

> **浏览器端不能直接接入。** 前端 JS 是明文的，`plugin_secret` 会被直接抠走。
> 网站的正确形态是：浏览器 → 你自己的后端（装 SDK）→ 卡密平台。

Node.js 示例：

```bash
pnpm add @jc-kami/sdk
```

```ts
import { LicenseClient, LicenseError, LicenseErrorCode } from '@jc-kami/sdk';

const client = new LicenseClient({
  appId: 'your_app',
  serverUrl: 'https://license.example.com',
  pluginId: process.env.JC_PLUGIN_ID!,
  pluginToken: process.env.JC_PLUGIN_TOKEN!,
  pluginSecret: process.env.JC_PLUGIN_SECRET!,
  clientVersion: '1.0.0',
  onPolicy: (policy) => {
    if (policy.notice) showNotice(policy.notice);
    if (policy.upgrade.required) blockAndPromptUpgrade(policy.upgrade);
  },
});

// 首次激活
await client.activate(userInputKey);

// 每次启动校验
try {
  const result = await client.verify();
  if (result.policy.upgrade.required) process.exit(1);
  startApp();
} catch (e) {
  if (e instanceof LicenseError && e.code === LicenseErrorCode.NOT_ACTIVATED_LOCALLY) {
    showActivationDialog();
  } else {
    showError(e);
  }
}
```

SDK 负责设备指纹、请求签名、令牌加密存储、离线宽限期和错误码映射。
判断分支只能依赖 `e.code`，不要匹配 `e.message`——文案会改，错误码不会。

## 安全须知

**签名密钥放在哪里，决定了这套系统能防住什么。**

- **服务端项目对接**（网站后端、API 服务）：密钥放在服务器环境变量里，客户端接触不到，
  签名机制能真正防伪造，这是最推荐的接入方式。
- **桌面 / 移动客户端对接**：密钥必然打包进客户端，可被逆向提取。这是客户端软件授权的
  固有限制，任何方案都绕不过去。此时签名的作用降级为「抬高门槛 + 便于溯源」，
  真正的防线是服务端侧的手段：设备绑定、并发限制、封禁、一键关停，以及把高价值功能
  放到服务端执行。

其余要点：

- 生产环境必须全站 HTTPS。
- 卡密数据库只存哈希与密文，后台默认展示脱敏值；导出明文需要独立的 `license:export` 权限并全程留痕。
- 插件密钥支持带宽限期轮换，Token 轮换则立即生效，泄露后可即时吊销。
- 权限校验全部在服务端执行，前端隐藏按钮只是体验优化，不是安全边界。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev:server` | 启动授权中心（热重载） |
| `pnpm dev:admin` | 启动管理后台 |
| `pnpm build` | 构建全部包 |
| `pnpm db:migrate` | 执行数据库迁移 |
| `pnpm db:seed` | 初始化角色与超级管理员 |
| `pnpm test:e2e` | 运行服务端端到端测试（需要 `jc_kami_test` 库） |
| `bash scripts/mint-test-licenses.sh` | 为 SDK 联调准备应用与新卡密（会在库里建 `sdk_demo` 应用） |
| `bash scripts/cleanup-demo-data.sh` | 清空业务数据与日志，保留管理员账号 |
| `node scripts/blackbox-test.js` | 黑盒安全测试（需服务端运行；自建测试数据） |
| `python3 packages/sdk-python/tests/integration_test.py` | Python SDK 联调（需先执行上一行） |
| `php packages/sdk-php/tests/integration_test.php` | PHP SDK 联调 |
| `dotnet run --project packages/sdk-csharp/tests/JcKami.Sdk.IntegrationTests` | C# SDK 联调 |
| `dotnet run --project packages/sdk-csharp/tests/JcKami.Sdk.UpdateTests` | C# SDK 远程更新联调（自建应用与更新包，无需前置脚本） |

> 联调脚本会在你指向的那个库里创建 `sdk_demo` 应用和一批卡密。
> 测完想恢复空白状态，跑 `bash scripts/cleanup-demo-data.sh` 即可，它会保留管理员账号。

端到端测试库首次准备：

```bash
mysql -u root -e "CREATE DATABASE jc_kami_test DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

```bash
cd packages/server && DATABASE_URL="mysql://root@127.0.0.1:3306/jc_kami_test" npx prisma migrate deploy
```

## 当前进度

已完成：
- **授权核心**：管理员登录、应用、套餐、卡密、激活、验证、设备绑定与换绑
- **远程管控**：一键关停、维护模式、版本策略、灰度发布、安装包托管
- **运营能力**：经营看板（趋势图/核销率）、批次管理（渠道标记/整批作废）、定时数据清理
- **Webhook 推送**：卡密与设备事件签名推送、失败退避重试、投递记录
- **四语言 SDK**：Node.js / Python / PHP / C#（.NET）
- **接入文档页**：后台内置，含协议、四语言示例、在线接口测试
- **96 项端到端测试** + 黑盒安全测试

未实现（对应设计文档第 15 章的后续阶段）：自建在线支付与收银（对接第三方发卡网则不需要）、
客户注册、多租户与分销、更多语言 SDK。
