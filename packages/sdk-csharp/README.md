# JcKami.Sdk (C# / .NET)

卡密平台 C# 客户端 SDK。面向 Windows 桌面软件授权这一经典场景。

**目标框架**：`netstandard2.0` + `net8.0`。
netstandard2.0 覆盖 .NET Framework 4.6.1 及以上，存量 WinForms / WPF 项目可以直接引用。

## 安装

```bash
dotnet add reference ../jc-kami/packages/sdk-csharp/src/JcKami.Sdk/JcKami.Sdk.csproj
```

或打包成 NuGet 后引用：

```bash
dotnet pack packages/sdk-csharp/src/JcKami.Sdk -c Release
```

## 用法

```csharp
using JcKami;

var client = new LicenseClient(new LicenseOptions
{
    AppId         = "my_tool",
    ServerUrl     = "https://license.example.com",
    PluginId      = "my_tool_default",
    PluginToken   = "pk_...",
    PluginSecret  = "sk_...",
    ClientVersion = "1.0.0",
});

// 处理公告与升级提示
client.PolicyReceived += policy =>
{
    if (policy?.Notice != null)
        ShowNotice(policy.Notice.Level, policy.Notice.Title, policy.Notice.Content);
};

// 首次激活
await client.ActivateAsync(userInputKey);

// 每次启动校验
try
{
    var result = await client.VerifyAsync();
    if (result.Policy?.Upgrade?.Required == true)
    {
        ShowForcedUpgrade(result.Policy.Upgrade);
        Environment.Exit(1);
    }
    StartApp();
}
catch (LicenseException ex)
{
    switch (ex.Code)
    {
        case ErrorCode.NotActivatedLocally: ShowActivationDialog();          break;
        case ErrorCode.LicenseExpired:      ShowMessage("授权已到期，请续费"); break;
        case ErrorCode.DeviceLimitExceeded: ShowMessage("设备数已满，请先解绑"); break;
        case ErrorCode.AppKilled:           ShowMessage(ex.Message);          break;
        default:                            ShowMessage($"[{ex.Code}] {ex.Message}"); break;
    }
}
```

WinForms / WPF 里调用异步方法请用 `async void` 事件处理器或 `await`，
不要用 `.Result` / `.Wait()`——那会在 UI 线程上死锁。

## 方法

| 方法 | 说明 |
| --- | --- |
| `ActivateAsync(licenseKey, idempotencyKey = null)` | 首次激活 |
| `VerifyAsync()` | 启动校验。网络不通时按宽限期本地放行，结果 `Offline = true` |
| `DeactivateAsync(reason = null)` | 解绑本机，消耗一次换绑配额 |
| `StatusAsync(licenseKey = null)` | 查询状态，不签发令牌 |
| `FetchPolicyAsync()` | 拉取远程管控策略，未激活时也可调用 |
| `CheckUpdateAsync(currentVersion = null)` | 查询有没有新版本，返回可交给 `Updater` 的 `UpdatePlan` |
| `HasLocalLicense()` / `ClearLocal()` | 本地凭据的判断与清除 |
| `DeviceId` | 本机设备指纹（只读属性） |
| `PolicyReceived` | 每次拿到策略时触发的事件 |

所有异步方法都支持传入 `CancellationToken`。
构造函数可以注入自己的 `HttpClient`，方便复用宿主程序已有的连接池与代理配置。

## 错误处理

分支判断只能依赖 `ex.Code`，不要匹配 `ex.Message`——文案会改，错误码不会。

```csharp
catch (LicenseException ex)
{
    ex.Code;         // LICENSE_EXPIRED 等标准错误码
    ex.HttpStatus;   // HTTP 状态码，本地错误为 0
    ex.RequestId;    // 服务端请求 ID，报障时提供
    ex.Details;      // 附加信息，如 retry_after、device_limit
    ex.IsRetryable;  // 是否值得重试
}
```

## 本地存储

默认写在 `%LOCALAPPDATA%\JcKami\<AppId>\`（可用 `StorageDir` 覆盖）：

- `device.salt` —— 设备指纹的随机盐。删掉它等同于换了台机器，需要重新激活或换绑。
  **请勿放在临时目录**，否则系统清理后用户会莫名其妙需要重新激活。
- `license.dat` —— 授权状态，AES-256-CBC 加密后再对 (IV ‖ 密文) 计算 HMAC-SHA256（encrypt-then-MAC）。

选 CBC + HMAC 而不是 AES-GCM，是因为 `AesGcm` 在 .NET Framework / netstandard2.0 上不存在，
而存量 Windows 桌面软件大量跑在 .NET Framework 上。

密钥由设备指纹派生，所以：文件拷到别的机器解不开；任何手工改动（比如把「上次验证时间」
往前挪来骗过离线宽限期）都会在校验 MAC 时被发现，抛 `LOCAL_STORAGE_TAMPERED`。
这几条都有对应的联调用例。

这不是为了防逆向——客户端代码永远可被逆向——而是让「改本地文件就能续命」这种
最低成本的绕过失效。真正的授权判断始终在服务端。

## 远程更新

```csharp
var plan = await client.CheckUpdateAsync("1.0.0");
if (plan.Available)
{
    // 公钥在后台应用详情页复制，必须硬编码进程序。
    // 绝不能从服务端下发 —— 那样篡改响应的人可以连公钥一起换掉，验签就形同虚设。
    using var updater = new Updater(AppContext.BaseDirectory, "<内置公钥 base64>");

    var result = await updater.ApplyAsync(plan,
        new Progress<(long Received, long Total)>(p => ShowBar(p.Received, p.Total)));

    if (result.Applied) updater.RestartAndExit();
}
```

装出来的目录结构：

```
应用根目录/
├── current.txt          指针，内容是当前生效的版本号
├── launcher.exe         按指针拉起对应版本（由你提供）
└── versions/
    ├── 1.1.0/
    └── 1.2.0/
```

不往正在运行的目录里解压，而是新版本进独立的 `versions/<版本>/`、再改指针切过去。
一来 Windows 上运行中的 exe 本来就没法覆盖自己，二来中途断电断网也不会把用户的软件
搞成半新半旧 —— 指针要么指向旧版本，要么指向完整的新版本。

| 成员 | 说明 |
| --- | --- |
| `ApplyAsync(plan, progress, allowPostInstall, restart)` | 下载 → 校验哈希 → 验签 → 解压 → 原子切换 → 清理旧版本 |
| `CurrentVersion()` / `InstalledVersions()` | 读指针 / 列出已安装版本 |
| `Rollback(version)` | 把指针改回某个已安装版本 |
| `Restart(launcher = null)` / `RestartAndExit()` | 拉起根目录下的 launcher（后者随即退出当前进程） |

安全上的几条硬规矩：

- **没有签名的包一律拒装。** 哈希只能防传输损坏，防不了篡改 —— 能改安装包的人同样能改
  哈希，只有平台私钥签的名他伪造不了。签名载荷含 `app_id + 版本 + 哈希 + 大小`，
  所以换包、改版本号、冒充别的应用都会当场失败。
- **解压做路径穿越防护。** 更新包来自网络，里面完全可能藏着 `../../Windows/System32`
  这样的条目；`ZipFile.ExtractToDirectory` 在老框架上并不拦这个，所以逐条目校验绝对路径。
- **`post_install` 默认不执行。** 它来自服务端且不在签名保护范围内，执行即等于任意代码执行。
  确有需要时传 `allowPostInstall: true` 显式开启。
- **`strip_root_dir` 只在所有条目共享同一个顶层目录时才剥。** 包本身是平铺的时候无脑剥一层，
  会把顶层文件整个丢掉，装出来的版本直接跑不起来。
- 版本号会被拼进路径，只放行字母数字和 `.-_+`；下载超出声明大小立即中止。

Ed25519 验签是 SDK 自带的一份 RFC 8032 实现（`Ed25519.cs`）：.NET 直到 8.0 都没有内置，
10.0 才补上，而这里要覆盖 `netstandard2.0` 且承诺零依赖。实现包含小阶点黑名单 —— 公钥一旦
被读成全零之类的坏值，攻击者就能构造出「对任意消息都验得过」的签名。

## 关于 PluginSecret

签名密钥打包进 exe 后可被反编译提取，这是客户端软件授权的固有限制，任何方案都绕不过去。
签名在这里的作用是「抬高门槛 + 便于溯源」，真正的防线是服务端侧手段：
设备绑定、封禁、一键远程关停，以及把高价值功能放到服务端执行。

详见 [接入指南](../../docs/INTEGRATION.md) 第 9 节。

## 联调测试

```bash
bash scripts/mint-test-licenses.sh
```

```bash
dotnet run --project packages/sdk-csharp/tests/JcKami.Sdk.IntegrationTests
```

19 项断言，覆盖激活、令牌滚动续期、设备上限、解绑、本地篡改检测（密文与 MAC 两种）、
跨设备解密失败、离线宽限期边界、签名错误、幂等键等。可反复执行。

更新链路另有一套端到端（自己建应用、造包、上传发布，不需要 `mint-test-licenses.sh`）：

```bash
dotnet run --project packages/sdk-csharp/tests/JcKami.Sdk.UpdateTests
```

67 项断言，覆盖 Ed25519 官方测试向量与小阶点/非规范 S 拒绝、真实下载安装、幂等、
公钥不匹配 / 版本号冒充 / 哈希不符 / 未签名 / 超出声明大小的拒装、Zip Slip、
智能剥层、回滚、版本号注入。

> 测试项目 TFM 为 `net8.0` 并开启了 `RollForward=LatestMajor`，
> 这样验证的是用户实际会引用的那份构建，而不是另编一份新框架的。
> `netstandard2.0` 目标经过编译验证；在 .NET Framework 上的运行时行为需要 Windows 环境实测。
