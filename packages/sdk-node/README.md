# @jc-kami/sdk

卡密平台的 Node.js 客户端 SDK。负责设备指纹、请求签名、令牌加密存储、离线宽限期和错误码映射。

## 安装

```bash
pnpm add @jc-kami/sdk
```

## 使用

```ts
import { LicenseClient } from '@jc-kami/sdk';

const client = new LicenseClient({
  appId: 'video_tool',
  serverUrl: 'https://license.example.com',
  pluginId: process.env.JC_PLUGIN_ID!,
  pluginToken: process.env.JC_PLUGIN_TOKEN!,
  pluginSecret: process.env.JC_PLUGIN_SECRET!,
  clientVersion: '1.0.0',
  onPolicy: (policy) => { /* 处理公告与升级提示 */ },
});
```

| 方法 | 说明 |
| --- | --- |
| `activate(licenseKey)` | 首次激活，凭据加密保存到本地 |
| `verify()` | 启动校验。网络不通时按服务端下发的宽限期本地放行，结果里 `offline: true` |
| `deactivate(reason?)` | 主动解绑本机，消耗一次换绑配额 |
| `status(licenseKey?)` | 查询授权状态，不签发令牌 |
| `fetchPolicy()` | 拉取远程管控策略，未激活时也可调用 |
| `hasLocalLicense()` | 本地是否存有激活凭据 |
| `clearLocal()` | 清除本地凭据，不通知服务端 |

## 错误处理

判断分支只能依赖 `error.code`，不要匹配 `error.message`——文案会改，错误码不会。

```ts
import { LicenseError, LicenseErrorCode } from '@jc-kami/sdk';

try {
  await client.verify();
} catch (e) {
  if (!(e instanceof LicenseError)) throw e;
  switch (e.code) {
    case LicenseErrorCode.NOT_ACTIVATED_LOCALLY: showActivationDialog(); break;
    case LicenseErrorCode.LICENSE_EXPIRED:       showRenewPage();        break;
    case LicenseErrorCode.DEVICE_LIMIT_EXCEEDED: showUnbindHint();       break;
    case LicenseErrorCode.APP_KILLED:            showMessage(e.message); break;
    default:                                     showError(e);
  }
  // e.retryable 标明该错误是否值得重试；e.requestId 可用于向服务方报障
}
```

## 远程更新

```ts
import { LicenseClient, Updater } from '@jc-kami/sdk';

const plan = await client.checkUpdate('1.1.0');
if (plan.available) {
  // 公钥必须内置在客户端。绝不能从服务端取——那样篡改响应的人可以连公钥一起换
  const updater = new Updater({ root: '/opt/myapp', publicKey: 'BASE64_ED25519_PUBLIC_KEY' });
  const result = await updater.apply(plan, {
    progress: (got, total) => console.log(`${got}/${total}`),
  });
  console.log(result.applied, result.version, result.path);
}
```

安装流程：下载（流式，校验声明大小）→ 校验 sha256 → 验 Ed25519 签名 → 解压到
`versions/<版本>.pending` → rename 成 `versions/<版本>` → 原子写 `current.txt` 指针 → 清理旧版本。
中途任何一步失败都抛 `LicenseError`，且不会动到当前正在用的版本。

- **没有签名的包一律拒装。** 哈希只能防传输损坏，防不了篡改——能改包的人同样能改哈希。
- **`post_install` 默认不执行。** 它来自服务端且不在签名保护范围内，执行等于远程代码执行；
  确需使用时传 `{ allowPostInstall: true }`。
- **`install_strategy: 'notify'` 时不自动安装**，直接返回 `skippedReason`。
  Electron 项目请在此处交给自己的 autoUpdater。
- 解压支持 zip（store / deflate，含 zip64）、tar、tar.gz，全部用 Node 内置能力实现，SDK 保持零依赖。
  不支持 zip 的其他压缩方式（bzip2、LZMA 等），遇到会直接报错而不是静默跳过。
- `updater.currentVersion()` / `installedVersions()` / `rollback(version)` 用于查看与回退；
  回退只改指针，旧版本目录按 `keepVersions`（默认 2）保留。

## 本地存储

授权状态存放在 `~/.jc-kami/<appId>/`（可用 `storageDir` 覆盖）：

- `device.salt` —— 设备指纹的随机盐。删掉它等同于换了台机器，需要重新激活或换绑。
- `license.dat` —— AES-256-GCM 加密的授权状态，密钥由设备指纹派生。
  复制到别的机器解不开，手工改动会在读取时被认证标签发现并报 `LOCAL_STORAGE_TAMPERED`。

这些措施是为了让「改本地文件续命」这类最低成本的绕过失效，不是为了防逆向。
客户端代码永远可被逆向，真正的授权判断始终在服务端。

## 关于 pluginSecret

签名密钥打包进桌面客户端后可被提取，这是客户端软件授权的固有限制。
如果对接方是服务端项目，请把密钥放在服务器环境变量里，不要下发给终端。
详见根目录 README 的「安全须知」。
