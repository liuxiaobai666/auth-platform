using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using JcKami;

// C# SDK 远程更新端到端：真服务端、真包、真安装，外加攻击场景。
// 前置：后端跑在 http://127.0.0.1:3100（cd packages/server && node dist/main.js）
// 用法: dotnet run --project tests/JcKami.Sdk.UpdateTests [服务端地址]

const string Green = "\u001b[32m";
const string Red = "\u001b[31m";
const string Bold = "\u001b[1m";
const string Reset = "\u001b[0m";

var baseUrl = (args.Length > 0 ? args[0] : "http://127.0.0.1:3100").TrimEnd('/');
var failures = 0;

void Ok(bool cond, string msg)
{
    Console.WriteLine(cond ? $"  {Green}✓{Reset} {msg}" : $"  {Red}✗ {msg}{Reset}");
    if (!cond) failures++;
}

void Section(string msg) => Console.WriteLine($"\n{Bold}{msg}{Reset}");

async Task ExpectReject(Func<Task> action, string label)
{
    try
    {
        await action();
        Ok(false, label + " → 竟然通过了!");
    }
    catch (LicenseException ex)
    {
        var brief = ex.Message.Length > 28 ? ex.Message[..28] + "..." : ex.Message;
        Ok(true, $"{label} → 拒绝（{brief}）");
    }
    catch (Exception ex)
    {
        Ok(false, $"{label} → 抛了非预期异常 {ex.GetType().Name}: {ex.Message}");
    }
}

Console.WriteLine($"{Bold}\n══════ C# SDK 更新端到端 ══════{Reset}");

// ==================================================================== 【0】Ed25519

Section("【0】Ed25519 验签（RFC 8032 §7.1 官方测试向量）");

byte[] Hex(string s) => Convert.FromHexString(s);

var vectors = new[]
{
    // pk, msg, sig
    ("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ("fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
    ("ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
     "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
     "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704"),
};

for (var i = 0; i < vectors.Length; i++)
{
    var (pk, msg, sig) = vectors[i];
    Ok(Ed25519.Verify(Hex(pk), Hex(msg), Hex(sig)), $"TEST {i + 1}（{msg.Length / 2} 字节消息）通过");
}

{
    var (pk, msg, sig) = vectors[1];

    var badSig = Hex(sig); badSig[0] ^= 0x01;
    Ok(!Ed25519.Verify(Hex(pk), Hex(msg), badSig), "签名改一个 bit → 拒绝");

    var badMsg = Hex(msg); badMsg[0] ^= 0x01;
    Ok(!Ed25519.Verify(Hex(pk), badMsg, Hex(sig)), "消息改一个 bit → 拒绝");

    Ok(!Ed25519.Verify(Hex(vectors[2].Item1), Hex(msg), Hex(sig)), "换一把公钥 → 拒绝");

    // 非规范 S：S += L 后代表同一个签名，必须拒绝以杜绝延展性
    var mutable = Hex(sig);
    var s = new System.Numerics.BigInteger(mutable.AsSpan(32, 32).ToArray().Append((byte)0).ToArray());
    var l = System.Numerics.BigInteger.Pow(2, 252)
            + System.Numerics.BigInteger.Parse("27742317777372353535851937790883648493");
    var raised = (s + l).ToByteArray();
    Array.Clear(mutable, 32, 32);
    Array.Copy(raised, 0, mutable, 32, Math.Min(32, raised.Length));
    Ok(!Ed25519.Verify(Hex(pk), Hex(msg), mutable), "非规范 S（S+L）→ 拒绝");

    // 小阶点：拿它当公钥能构造出「对任意消息都验得过」的签名
    Ok(!Ed25519.Verify(new byte[32], Hex(msg), Hex(sig)), "全零公钥（小阶点）→ 拒绝");
    Ok(!Ed25519.Verify(Hex("0100000000000000000000000000000000000000000000000000000000000000"),
            Hex(msg), Hex(sig)), "单位元公钥（小阶点）→ 拒绝");
    Ok(!Ed25519.Verify(Hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
            Hex(msg), Hex(sig)), "y=p-1 小阶点公钥 → 拒绝");

    Ok(!Ed25519.Verify(new byte[31], Hex(msg), Hex(sig)), "公钥长度不对 → 拒绝");
    Ok(!Ed25519.Verify(Hex(pk), Hex(msg), new byte[63]), "签名长度不对 → 拒绝");
}

// ==================================================================== 准备

using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };

async Task<JsonElement> Api(HttpMethod method, string path, object body = null,
                            string token = null, HttpContent raw = null)
{
    using var req = new HttpRequestMessage(method, baseUrl + path);
    if (token != null) req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
    if (raw != null) req.Content = raw;
    else if (body != null)
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

    using var resp = await http.SendAsync(req);
    var text = await resp.Content.ReadAsStringAsync();
    return JsonDocument.Parse(string.IsNullOrEmpty(text) ? "{}" : text).RootElement.Clone();
}

var work = Path.Combine(Path.GetTempPath(), "cs-update-" + Guid.NewGuid().ToString("N")[..8]);
Directory.CreateDirectory(work);

var login = await Api(HttpMethod.Post, "/api/v1/admin/auth/login",
    new { username = "admin", password = "Admin@123456" });
if (!login.TryGetProperty("access_token", out var tokenEl))
{
    Console.WriteLine($"{Red}无法登录后台，请确认服务端已启动：{login}{Reset}");
    return 1;
}
var admin = tokenEl.GetString();

var appId = "csup_" + Guid.NewGuid().ToString("N")[..6];
var app = await Api(HttpMethod.Post, "/api/v1/admin/applications",
    new { app_id = appId, name = "C# 更新演示", type = "windows" }, admin);
var appUuid = app.GetProperty("id").GetString();
var detail = await Api(HttpMethod.Get, $"/api/v1/admin/applications/{appUuid}", null, admin);
var publicKey = detail.GetProperty("update_sign_public_key").GetString();
var plugin = app.GetProperty("default_plugin");
var cred = plugin.GetProperty("credentials");

// ==================================================================== 【1】造包

Section("【1】造一个 onedir 结构的更新包");

var pkg = Path.Combine(work, "YourApp-1.2.0.zip");
using (var fs = File.Create(pkg))
using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
{
    // 模拟 PyInstaller / dotnet publish 的 onedir 产物，外层多套一层目录（测 strip_root_dir）
    void Add(string name, byte[] data)
    {
        using var s = zip.CreateEntry(name).Open();
        s.Write(data, 0, data.Length);
    }
    Add("YourApp/app.exe", Encoding.UTF8.GetBytes("FAKE-EXE-v1.2.0"));
    Add("YourApp/_internal/hostpolicy.dll", Encoding.UTF8.GetBytes(new string('D', 3000)));
    Add("YourApp/_internal/lib/data.json", Encoding.UTF8.GetBytes("{\"ver\":\"1.2.0\"}"));
    Add("YourApp/README.txt", Encoding.UTF8.GetBytes("v1.2.0 说明"));
}
var pkgBytes = await File.ReadAllBytesAsync(pkg);
var pkgSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(pkgBytes)).ToLowerInvariant();
Ok(pkgBytes.Length > 0, $"包已生成 {pkgBytes.Length} 字节，含嵌套目录");

// ==================================================================== 【2】上传发布

Section("【2】上传并发布");

var form = new MultipartFormDataContent("----jck" + Guid.NewGuid().ToString("N"));
void Field(string name, string value) => form.Add(new StringContent(value), name);
Field("application_id", appUuid);
Field("version", "1.2.0");
Field("channel", "stable");
Field("package_type", "onedir");
Field("install_strategy", "versioned");
Field("strip_root_dir", "true");
Field("entry", "app.exe");
Field("release_notes", "新版本");
var filePart = new ByteArrayContent(pkgBytes);
filePart.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
form.Add(filePart, "file", "YourApp-1.2.0.zip");

var release = await Api(HttpMethod.Post, "/api/v1/admin/releases", null, admin, form);
if (!release.TryGetProperty("id", out var relIdEl))
{
    Console.WriteLine($"{Red}上传失败：{release}{Reset}");
    return 1;
}
Ok(release.GetProperty("sha256").GetString() == pkgSha, "服务端哈希与本地一致");

var published = await Api(HttpMethod.Post,
    $"/api/v1/admin/releases/{relIdEl.GetString()}/publish", new { }, admin);
Ok(published.TryGetProperty("signed", out var signedEl) && signedEl.GetBoolean(), "发布并已签名");

// ==================================================================== 【3】检查更新

Section("【3】客户端检查更新");

var root = Path.Combine(work, "InstallRoot");
Directory.CreateDirectory(root);

using var client = new LicenseClient(new LicenseOptions
{
    AppId = appId,
    ServerUrl = baseUrl,
    PluginId = plugin.GetProperty("plugin_id").GetString(),
    PluginToken = cred.GetProperty("plugin_token").GetString(),
    PluginSecret = cred.GetProperty("plugin_secret").GetString(),
    DeviceId = "cs-dev-001",
    StorageDir = Path.Combine(work, "state"),
});

var plan = await client.CheckUpdateAsync("1.1.0");
Ok(plan.Available && plan.Version == "1.2.0", $"发现新版本 {plan.Version}");
Ok(plan.PackageType == "onedir" && plan.InstallStrategy == "versioned", "拿到安装策略");
Ok(plan.StripRootDir && plan.Entry == "app.exe", "拿到剥层/入口配置");
Ok(plan.Signed, "包含签名");
Ok(plan.FileSize == pkgBytes.Length && plan.Sha256 == pkgSha, "大小与哈希与本地一致");

var upToDate = await client.CheckUpdateAsync("1.2.0");
Ok(!upToDate.Available, "已是最新版时 Available=false");

// ==================================================================== 【4】安装

Section("【4】执行安装");

var counter = new Counter();
using var updater = new Updater(root, publicKey);
var result = await updater.ApplyAsync(plan, counter);

Ok(result.Applied, $"安装成功 → {Path.GetRelativePath(root, result.Path)}");
Ok(counter.Count > 0, $"下载进度回调触发 {counter.Count} 次（最终 {counter.Last}/{counter.Total} 字节）");
Ok(updater.CurrentVersion() == "1.2.0", "current.txt 指针已切到 1.2.0");

var inst = Path.Combine(root, "versions", "1.2.0");
Ok(File.Exists(Path.Combine(inst, "app.exe")), "app.exe 就位（外层 YourApp/ 已剥掉）");
Ok(File.Exists(Path.Combine(inst, "_internal", "hostpolicy.dll")), "嵌套目录 _internal/ 完整解压");
Ok(await File.ReadAllTextAsync(Path.Combine(inst, "app.exe")) == "FAKE-EXE-v1.2.0", "文件内容正确");
Ok(await File.ReadAllTextAsync(Path.Combine(inst, "_internal", "lib", "data.json")) == "{\"ver\":\"1.2.0\"}",
    "深层文件正确");
Ok(!Directory.Exists(Path.Combine(inst, "YourApp")), "strip_root_dir 生效，没有多余层级");
Ok(!Directory.Exists(inst + ".pending"), "临时 .pending 目录已清理");
Ok(updater.InstalledVersions().Contains("1.2.0"), "InstalledVersions() 列出 1.2.0");

// ==================================================================== 【5】幂等

Section("【5】幂等：重复安装同版本不重做");
var again = await updater.ApplyAsync(plan);
Ok(!again.Applied && (again.SkippedReason ?? "").Contains("已是该版本"), "识别为已安装，跳过");

var notifyPlan = await client.CheckUpdateAsync("1.1.0");
notifyPlan.InstallStrategy = "notify";
var notified = await updater.ApplyAsync(notifyPlan);
Ok(!notified.Applied && (notified.SkippedReason ?? "").Contains("notify"), "notify 策略不自动安装");

// ==================================================================== 【6】攻击场景

Section("【6】攻击场景：必须拒绝");

var root2 = Path.Combine(work, "Root2");
Directory.CreateDirectory(root2);

UpdatePlan Clone(Action<UpdatePlan> mutate = null)
{
    var p = new UpdatePlan
    {
        AppId = plan.AppId,
        Available = true,
        Version = plan.Version,
        DownloadUrl = plan.DownloadUrl,
        Sha256 = plan.Sha256,
        FileSize = plan.FileSize,
        Signature = plan.Signature,
        PackageType = "onedir",
        InstallStrategy = "versioned",
        StripRootDir = true,
    };
    mutate?.Invoke(p);
    return p;
}

// 攻击者拿自己的私钥重签了包 —— 客户端内置的公钥对不上（用 RFC 向量里的公钥冒充）
var attackerKey = Convert.ToBase64String(Hex(vectors[0].Item1));
await ExpectReject(async () =>
{
    using var u = new Updater(root2, attackerKey);
    await u.ApplyAsync(Clone());
}, "公钥不匹配（伪造签名）");

await ExpectReject(async () =>
{
    using var u = new Updater(root2, publicKey);
    await u.ApplyAsync(Clone(p => p.Version = "9.9.9"));
}, "冒充更高版本号");

await ExpectReject(async () =>
{
    using var u = new Updater(root2, publicKey);
    await u.ApplyAsync(Clone(p => p.AppId = "someone_else"));
}, "冒充其他应用的包");

await ExpectReject(async () =>
{
    using var u = new Updater(root2, publicKey);
    await u.ApplyAsync(Clone(p => p.Sha256 = new string('0', 64)));
}, "哈希对不上（包被换）");

await ExpectReject(async () =>
{
    using var u = new Updater(root2, publicKey);
    await u.ApplyAsync(Clone(p => p.Signature = null));
}, "未签名的包");

await ExpectReject(async () =>
{
    using var u = new Updater(root2, publicKey);
    await u.ApplyAsync(Clone(p => p.FileSize = 10));
}, "声明大小被改小（下载超限）");

await ExpectReject(() => Task.FromResult(new Updater(root2, "")),
    "构造 Updater 时不给公钥");

Ok(!Directory.Exists(Path.Combine(root2, "versions", "1.2.0")), "所有攻击都没落地任何版本目录");

// post_install 默认不执行：它来自服务端且不在签名保护范围内
var probe = Path.Combine(work, "post-install-ran.txt");
var root3 = Path.Combine(work, "Root3");
Directory.CreateDirectory(root3);
using (var u = new Updater(root3, publicKey))
{
    var p = Clone();
    p.PostInstall = $"echo pwned > \"{probe}\"";
    var r = await u.ApplyAsync(p);
    Ok(r.Applied && !File.Exists(probe), "post_install 默认不执行（需显式 allowPostInstall）");
}

// ==================================================================== 【7】Zip Slip

Section("【7】Zip Slip 路径穿越攻击");

var pwned = Path.Combine(Path.GetTempPath(), "jck-cs-pwned.txt");
if (File.Exists(pwned)) File.Delete(pwned);

var evil = Path.Combine(work, "evil.zip");
using (var fs = File.Create(evil))
using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
{
    using (var s = zip.CreateEntry("../../../../../../../tmp/jck-cs-pwned.txt").Open())
        s.Write("PWNED"u8.ToArray());
    using (var s = zip.CreateEntry("app.exe").Open())
        s.Write("x"u8.ToArray());
}
var slipDest = Path.Combine(work, "extract-test");
try
{
    Updater.ExtractArchive(evil, slipDest, false);
    Ok(false, "含 ../ 的恶意包 → 竟然没拒绝");
}
catch (LicenseException ex)
{
    Ok(true, $"含 ../ 的恶意包 → 直接拒绝（{ex.Message[..Math.Min(30, ex.Message.Length)]}...）");
}
Ok(!File.Exists(pwned), "确认 /tmp 未被写入");

// 绝对路径条目同样要挡
var evil2 = Path.Combine(work, "evil2.zip");
using (var fs = File.Create(evil2))
using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
{
    using var s = zip.CreateEntry("a/../../../../../../tmp/jck-cs-pwned.txt").Open();
    s.Write("PWNED"u8.ToArray());
}
await ExpectReject(() => { Updater.ExtractArchive(evil2, slipDest + "2", false); return Task.CompletedTask; },
    "中段带 ../ 的条目");
Ok(!File.Exists(pwned), "再次确认 /tmp 未被写入");

// ==================================================================== 【8】智能剥层

Section("【8】strip_root_dir 智能剥层");

string MakeZip(string name, params string[] entries)
{
    var path = Path.Combine(work, name);
    using var fs = File.Create(path);
    using var zip = new ZipArchive(fs, ZipArchiveMode.Create);
    foreach (var e in entries)
    {
        using var s = zip.CreateEntry(e).Open();
        s.Write(Encoding.UTF8.GetBytes(e));
    }
    return path;
}

var flat = MakeZip("flat.zip", "app.exe", "_internal/x.dll", "README.txt");
var flatDest = Path.Combine(work, "flat-out");
Updater.ExtractArchive(flat, flatDest, true);
Ok(File.Exists(Path.Combine(flatDest, "app.exe")) &&
   File.Exists(Path.Combine(flatDest, "_internal", "x.dll")),
   "平铺结构开了 strip_root_dir 也原样保留（不会把顶层文件丢光）");

var multi = MakeZip("multi.zip", "A/one.txt", "B/two.txt");
var multiDest = Path.Combine(work, "multi-out");
Updater.ExtractArchive(multi, multiDest, true);
Ok(Directory.Exists(Path.Combine(multiDest, "A")) && Directory.Exists(Path.Combine(multiDest, "B")),
   "多个并列顶层目录不剥（剥了会撞名）");

var nested = MakeZip("nested.zip", "Only/one.txt", "Only/sub/two.txt");
var nestedDest = Path.Combine(work, "nested-out");
Updater.ExtractArchive(nested, nestedDest, true);
Ok(File.Exists(Path.Combine(nestedDest, "one.txt")) &&
   File.Exists(Path.Combine(nestedDest, "sub", "two.txt")),
   "唯一顶层目录才剥");

Updater.ExtractArchive(nested, nestedDest + "-keep", false);
Ok(File.Exists(Path.Combine(nestedDest + "-keep", "Only", "one.txt")),
   "strip_root_dir=false 时保留原层级");

// ==================================================================== 【9】回滚

Section("【9】回滚与版本保留");

Directory.CreateDirectory(Path.Combine(root, "versions", "1.1.0"));
updater.Rollback("1.1.0");
Ok(updater.CurrentVersion() == "1.1.0", "指针已回滚到 1.1.0");
Ok(Directory.Exists(Path.Combine(root, "versions", "1.2.0")), "回滚后旧版本目录仍在，可以再切回去");

updater.Rollback("1.2.0");
Ok(updater.CurrentVersion() == "1.2.0", "可以再切回 1.2.0");

await ExpectReject(() => { updater.Rollback("8.8.8"); return Task.CompletedTask; }, "回滚到未安装的版本");

// ==================================================================== 【10】版本号注入

Section("【10】版本号注入防护");

foreach (var badVersion in new[] { "../../etc", "..", "/abs", "a b", "", "  ", "C:\\win", ".hidden", "1.0/../2.0" })
    await ExpectReject(() => { Updater.SafeVersion(badVersion); return Task.CompletedTask; },
        $"非法版本号 '{badVersion}'");

foreach (var good in new[] { "1.2.0", "2.0.0-beta.1", "1_0+build5" })
    Ok(Updater.SafeVersion(good) == good, $"合法版本号 '{good}' 放行");

// ==================================================================== 【11】权限位

Section("【11】Unix 权限位：可执行文件解压后还得是可执行的");

if (OperatingSystem.IsWindows())
{
    Ok(true, "Windows 无权限位概念，跳过");
}
else
{
    var permZip = Path.Combine(work, "perm.zip");
    using (var fs = File.Create(permZip))
    using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
    {
        // 高 16 位是 Unix mode，0100000 是 S_IFREG（普通文件）标志位
        void Add(string name, int mode)
        {
            var entry = zip.CreateEntry(name);
            entry.ExternalAttributes = mode << 16;
            using var s = entry.Open();
            s.Write(Encoding.UTF8.GetBytes(name));
        }

        Add("bin/run.sh", Convert.ToInt32("100755", 8));
        Add("data.txt", Convert.ToInt32("100644", 8));
        Add("bin/suid", Convert.ToInt32("104755", 8));
    }

    var permDest = Path.Combine(work, "perm-out");
    Updater.ExtractArchive(permZip, permDest, false);

    int ModeOf(string rel) =>
        (int)File.GetUnixFileMode(Path.Combine(permDest, rel)) & 0xFFF;

    var runMode = ModeOf("bin/run.sh");
    var txtMode = ModeOf("data.txt");
    var suidMode = ModeOf("bin/suid");

    Ok(runMode == Convert.ToInt32("755", 8), $"755 的可执行文件恢复了执行位（实际 {Convert.ToString(runMode, 8)}）");
    Ok(txtMode == Convert.ToInt32("644", 8), $"644 的普通文件权限不变（实际 {Convert.ToString(txtMode, 8)}）");
    Ok((suidMode & Convert.ToInt32("4000", 8)) == 0,
       $"setuid 位被丢弃，防止提权（实际 {Convert.ToString(suidMode, 8)}）");
    Ok((suidMode & Convert.ToInt32("111", 8)) != 0,
       $"但执行位仍保留（实际 {Convert.ToString(suidMode, 8)}）");
}

// ==================================================================== 收尾

try { Directory.Delete(work, true); } catch { /* 清理失败不影响结论 */ }

Console.WriteLine(failures == 0
    ? $"\n{Green}全部通过{Reset}\n"
    : $"\n{Red}{failures} 项失败{Reset}\n");

return failures == 0 ? 0 : 1;

/// <summary>Progress&lt;T&gt; 会把回调抛到线程池，断言可能读到旧值，这里直接同步计数。</summary>
sealed class Counter : IProgress<(long Received, long Total)>
{
    public int Count;
    public long Last;
    public long Total;

    public void Report((long Received, long Total) value)
    {
        Count++;
        Last = value.Received;
        Total = value.Total;
    }
}
