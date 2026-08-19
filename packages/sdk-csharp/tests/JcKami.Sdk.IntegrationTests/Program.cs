using System.Globalization;
using JcKami;

// 对着真实服务端跑的联调。先执行 scripts/mint-test-licenses.sh 准备环境。
// 用法: dotnet run --project tests/JcKami.Sdk.IntegrationTests [env 文件路径]

const string Green = "[32m";
const string Red = "[31m";
const string Bold = "[1m";
const string Reset = "[0m";

var envPath = args.Length > 0 ? args[0] : "/tmp/sdk.env";
var env = File.ReadAllLines(envPath)
    .Where(l => l.Contains('='))
    .ToDictionary(l => l[..l.IndexOf('=')], l => l[(l.IndexOf('=') + 1)..]);

var run = Guid.NewGuid().ToString("N")[..8];
var storeRoot = Path.Combine(Path.GetTempPath(), "cs-sdk-" + run);
var failures = 0;
var policyCount = 0;

void Ok(string m) => Console.WriteLine($"  {Green}✓{Reset} {m}");
void Bad(string m) { Console.WriteLine($"  {Red}✗ {m}{Reset}"); failures++; }
void Section(string m) => Console.WriteLine($"\n{Bold}{m}{Reset}");

LicenseClient Make(string store = null, string deviceId = null, string version = "1.0.0") =>
    new(new LicenseOptions
    {
        AppId = "sdk_demo",
        ServerUrl = "http://127.0.0.1:3100",
        PluginId = env["SDK_PLUGIN"],
        PluginToken = env["SDK_TOKEN"],
        PluginSecret = env["SDK_SECRET"],
        ClientVersion = version,
        StorageDir = store ?? Path.Combine(storeRoot, "main"),
        DeviceId = deviceId,
    });

async Task ExpectCode(Func<Task> action, string expected, string label)
{
    try
    {
        await action();
        Bad($"{label} 应当抛错但没有");
    }
    catch (LicenseException ex)
    {
        if (ex.Code == expected) Ok($"{label}: {ex.Code} — {ex.Message}");
        else Bad($"{label} 期望 {expected}，实际 {ex.Code} ({ex.Message})");
    }
}

Section("【1】未激活时 verify");
var client = Make();
client.PolicyReceived += _ => policyCount++;
Console.WriteLine($"     设备指纹: {client.DeviceId[..16]}...");
await ExpectCode(() => client.VerifyAsync(), ErrorCode.NotActivatedLocally, "未激活");

Section("【2】拉取策略（未激活也能调）");
var policy = await client.FetchPolicyAsync();
Ok($"app_status={policy.AppStatus}  kill_switch={policy.KillSwitch}  最新版本={policy.Upgrade.LatestVersion ?? "未发布"}");

Section("【3】激活");
var act = await client.ActivateAsync(env["SDK_FRESH6"]);
Ok($"license_id={act.LicenseId}  到期={act.ExpiresAt?[..10]}  设备 {act.DeviceCount}/{act.DeviceLimit}  离线宽限 {act.OfflineGraceHours}h");

Section("【4】启动校验（令牌滚动续期）");
var v1 = await client.VerifyAsync();
if (v1.LicenseToken != act.LicenseToken) Ok("验证通过，换发了新令牌");
else Bad("令牌未变化");

Section("【5】本地凭据");
if (client.HasLocalLicense()) Ok("HasLocalLicense() = true");
else Bad("本地应存有凭据");

Section("【6】错误卡密");
using (var c = Make(Path.Combine(storeRoot, "wrong"), $"cs-wrong-{run}"))
    await ExpectCode(() => c.ActivateAsync("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ"),
        ErrorCode.LicenseNotFound, "不存在的卡密");

// 用独立卡密：解绑会递增该卡密的 tokenVersion，作废它已签发的全部令牌，
// 跟主客户端共用一张卡的话，第 9 步就会拿到一枚已被作废的令牌
Section("【7】超出设备上限（上限 2）");
using (var c1 = Make(Path.Combine(storeRoot, "d1"), $"cs-dev1-{run}"))
using (var c2 = Make(Path.Combine(storeRoot, "d2"), $"cs-dev2-{run}"))
using (var c3 = Make(Path.Combine(storeRoot, "d3"), $"cs-dev3-{run}"))
{
    await c1.ActivateAsync(env["SDK_FRESH7"]);
    await c2.ActivateAsync(env["SDK_FRESH7"]);
    Ok("两台设备绑定成功");
    await ExpectCode(() => c3.ActivateAsync(env["SDK_FRESH7"]),
        ErrorCode.DeviceLimitExceeded, "第 3 台设备");

    Section("【8】主动解绑（消耗换绑配额）");
    var de = await c2.DeactivateAsync("换机器");
    Ok($"已解绑，剩余换绑 {de.RebindRemaining?.ToString() ?? "不限"}");
}

Section("【9】本地文件防篡改（encrypt-then-MAC）");
var statePath = Path.Combine(storeRoot, "main", "license.dat");
var bytes = await File.ReadAllBytesAsync(statePath);

bytes[^8] ^= 0xFF;                                   // 改动密文里的一个字节
await File.WriteAllBytesAsync(statePath, bytes);
await ExpectCode(() => client.VerifyAsync(), ErrorCode.LocalStorageTampered, "篡改密文");

bytes[^8] ^= 0xFF;                                   // 复原密文
bytes[0] ^= 0xFF;                                    // 改动 MAC
await File.WriteAllBytesAsync(statePath, bytes);
await ExpectCode(() => client.VerifyAsync(), ErrorCode.LocalStorageTampered, "篡改 MAC");

bytes[0] ^= 0xFF;                                    // 全部复原
await File.WriteAllBytesAsync(statePath, bytes);
var restored = await client.VerifyAsync();
if (restored.Success) Ok("复原后可正常验证，说明检测不是误报");
else Bad("复原后仍失败");

Section("【10】换台机器解不开（密钥由设备指纹派生）");
using (var other = Make(Path.Combine(storeRoot, "main"), $"different-device-{run}"))
    await ExpectCode(() => other.VerifyAsync(), ErrorCode.LocalStorageTampered, "他机读取同一文件");

Section("【11】离线宽限期");
using (var off = Make(Path.Combine(storeRoot, "offline")))
{
    await off.ActivateAsync(env["SDK_FRESH8"]);
    var storage = new SecureStorage(
        Path.Combine(storeRoot, "offline", "license.dat"), off.DeviceId);

    var st = storage.Read();
    st.LastVerifiedAt = DateTimeOffset.UtcNow.AddDays(-10).ToString("o", CultureInfo.InvariantCulture);
    storage.Write(st);

    // 指向一个连不上的端口来模拟断网
    using var far = new LicenseClient(new LicenseOptions
    {
        AppId = "sdk_demo",
        ServerUrl = "http://127.0.0.1:59999",
        PluginId = env["SDK_PLUGIN"],
        PluginToken = env["SDK_TOKEN"],
        PluginSecret = env["SDK_SECRET"],
        StorageDir = Path.Combine(storeRoot, "offline"),
        DeviceId = off.DeviceId,
        MaxRetries = 0,
        TimeoutMs = 2000,
    });
    await ExpectCode(() => far.VerifyAsync(), ErrorCode.NetworkUnavailable, "超过宽限期");

    st.LastVerifiedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);
    storage.Write(st);
    var offlineOk = await far.VerifyAsync();
    if (offlineOk.Offline) Ok("宽限期内离线放行: Offline=true");
    else Bad("未走离线分支");
}

Section("【12】状态查询不签发令牌");
var status = await client.StatusAsync();
Ok($"status={status.Status}  本机已绑定={status.DeviceBound}  设备 {status.DeviceCount}/{status.DeviceLimit}");

Section("【13】签名错误可被识别");
using (var badSig = new LicenseClient(new LicenseOptions
{
    AppId = "sdk_demo",
    ServerUrl = "http://127.0.0.1:3100",
    PluginId = env["SDK_PLUGIN"],
    PluginToken = env["SDK_TOKEN"],
    PluginSecret = "sk_totally_wrong",
    MaxRetries = 0,
    StorageDir = Path.Combine(storeRoot, "badsig"),
}))
    await ExpectCode(() => badSig.FetchPolicyAsync(), ErrorCode.SignatureInvalid, "错误密钥");

Section("【14】幂等键");
using (var idem = Make(Path.Combine(storeRoot, "idem"), $"cs-idem-{run}"))
{
    var key = "cs-idem-" + run;
    var a = await idem.ActivateAsync(env["SDK_FRESH9"], key);
    var b = await idem.ActivateAsync(env["SDK_FRESH9"], key);
    if (a.LicenseToken == b.LicenseToken) Ok("第二次直接回放首次结果");
    else Bad("幂等未生效");
}

Section("【15】缺少必填项时明确报错");
try
{
    _ = new LicenseClient(new LicenseOptions { AppId = "x" });
    Bad("应当抛 ArgumentException");
}
catch (ArgumentException ex)
{
    Ok($"构造校验: {ex.Message}");
}

client.Dispose();
try { Directory.Delete(storeRoot, true); } catch { /* 清理失败不影响结论 */ }

Console.WriteLine(failures == 0
    ? $"\n{Green}全部通过{Reset}  （共触发 {policyCount} 次策略回调）\n"
    : $"\n{Red}{failures} 项失败{Reset}\n");

return failures == 0 ? 0 : 1;
