using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace JcKami
{
    /// <summary>
    /// 一次更新的完整描述，由 policy 的 upgrade 段解析而来。
    /// </summary>
    public class UpdatePlan
    {
        /// <summary>应用标识。参与签名载荷，必须与发布时一致。</summary>
        public string AppId { get; set; }

        public bool Available { get; set; }

        /// <summary>为真表示不升级就不能继续使用，客户端应当阻断启动。</summary>
        public bool Required { get; set; }

        public bool Mandatory { get; set; }

        public string Version { get; set; }
        public string DownloadUrl { get; set; }
        public string Sha256 { get; set; }
        public long? FileSize { get; set; }
        public string Signature { get; set; }
        public string ReleaseNotes { get; set; }
        public string Message { get; set; }

        /// <summary>zip / onefile / onedir，缺省 zip。</summary>
        public string PackageType { get; set; } = "zip";

        /// <summary>versioned / replace / notify，缺省 versioned。</summary>
        public string InstallStrategy { get; set; } = "versioned";

        public bool StripRootDir { get; set; }
        public string Entry { get; set; }
        public string PostInstall { get; set; }

        /// <summary>没有签名的包一律拒绝安装。</summary>
        public bool Signed => !string.IsNullOrEmpty(Signature);

        public UpdatePlan() { }

        public UpdatePlan(string appId, UpgradePolicy upgrade)
        {
            AppId = appId;
            if (upgrade == null) return;

            Available = upgrade.Available;
            Required = upgrade.Required;
            Mandatory = upgrade.Mandatory;
            Version = upgrade.LatestVersion;
            DownloadUrl = upgrade.DownloadUrl;
            Sha256 = upgrade.Sha256;
            FileSize = upgrade.FileSize;
            Signature = upgrade.Signature;
            ReleaseNotes = upgrade.ReleaseNotes;
            Message = upgrade.Message;

            var package = upgrade.Package;
            if (package == null) return;
            if (!string.IsNullOrEmpty(package.Type)) PackageType = package.Type;
            if (!string.IsNullOrEmpty(package.InstallStrategy)) InstallStrategy = package.InstallStrategy;
            StripRootDir = package.StripRootDir;
            Entry = package.Entry;
            PostInstall = package.PostInstall;
        }

        public override string ToString() =>
            $"<UpdatePlan {Version} available={Available} required={Required}>";
    }

    /// <summary>一次安装的结果。</summary>
    public class UpdateResult
    {
        public bool Applied { get; set; }
        public string Version { get; set; }

        /// <summary>新版本落地的目录。未安装时为 null。</summary>
        public string Path { get; set; }

        public bool Restarted { get; set; }

        /// <summary>没有执行安装时的原因，例如「已是该版本」。</summary>
        public string SkippedReason { get; set; }

        public UpdateResult(bool applied, string version, string path,
                            bool restarted = false, string skippedReason = null)
        {
            Applied = applied;
            Version = version;
            Path = path;
            Restarted = restarted;
            SkippedReason = skippedReason;
        }

        public override string ToString() => $"<UpdateResult applied={Applied} version={Version}>";
    }

    /// <summary>
    /// 把一次 <see cref="UpdatePlan"/> 落到磁盘上。
    ///
    /// 设计要点：
    /// - 永远不往正在运行的目录里解压。新版本进独立的 versions/&lt;版本&gt;/，
    ///   再改一个指针文件切过去，所以中途断电、断网都不会把用户的软件搞成半新半旧。
    ///   Windows 上运行中的 exe 无法覆盖自己，这也是唯一能自更新的做法。
    /// - 装之前必须验 Ed25519 签名。哈希只能防传输损坏，防不了篡改。
    /// - 解压做路径穿越防护。压缩包里一个 ../../ 就能写到目录之外，
    ///   而更新包恰恰来自网络，这是必须堵死的口子。
    ///
    /// <code>
    /// var plan = await client.CheckUpdateAsync("1.0.0");
    /// if (plan.Available)
    /// {
    ///     var updater = new Updater(AppContext.BaseDirectory, "&lt;内置公钥 base64&gt;");
    ///     var result = await updater.ApplyAsync(plan);
    ///     if (result.Applied) updater.RestartAndExit();
    /// }
    /// </code>
    /// </summary>
    public class Updater : IDisposable
    {
        /// <summary>指针文件名，内容是当前生效的版本号。</summary>
        public const string CurrentPointer = "current.txt";

        private const string SignPrefix = "jc-kami-release-v1";
        private const int DownloadChunk = 256 * 1024;

        private readonly HttpClient _http;
        private readonly bool _ownsHttp;
        private string _actualSha256;

        /// <summary>应用根目录，versions/ 与 current.txt 都放在这里。</summary>
        public string Root { get; }

        /// <summary>保留几个历史版本，用于回滚。</summary>
        public int KeepVersions { get; }

        /// <param name="root">应用根目录</param>
        /// <param name="publicKey">
        /// 应用的验签公钥（裸 32 字节的 base64），必须内置在客户端里。
        /// 绝不能从服务端下发 —— 那样篡改响应的人可以连公钥一起换。
        /// </param>
        /// <param name="keepVersions">保留几个历史版本</param>
        /// <param name="httpClient">可注入宿主已有的 HttpClient</param>
        public Updater(string root, string publicKey, int keepVersions = 2, HttpClient httpClient = null)
        {
            if (string.IsNullOrWhiteSpace(publicKey))
                throw new LicenseException(ErrorCode.InternalError,
                    "必须提供验签公钥：没有它就无法判断安装包是否被篡改");
            if (string.IsNullOrWhiteSpace(root))
                throw new ArgumentException("root 不能为空", nameof(root));

            Root = Path.GetFullPath(root);
            PublicKey = publicKey;
            KeepVersions = Math.Max(1, keepVersions);

            _ownsHttp = httpClient == null;
            _http = httpClient ?? new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        }

        private string PublicKey { get; }

        // ================================================================ 路径

        public string VersionsDir => Path.Combine(Root, "versions");

        public string PointerPath => Path.Combine(Root, CurrentPointer);

        /// <summary>某个版本的安装目录。版本号非法时抛错。</summary>
        public string VersionPath(string version) => Path.Combine(VersionsDir, SafeVersion(version));

        /// <summary>当前指针指向的版本，没有则返回 null。</summary>
        public string CurrentVersion()
        {
            try
            {
                var value = File.ReadAllText(PointerPath, Encoding.UTF8).Trim();
                return string.IsNullOrEmpty(value) ? null : value;
            }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }

        /// <summary>已安装的版本列表，按名称排序。</summary>
        public IList<string> InstalledVersions()
        {
            try
            {
                return Directory.GetDirectories(VersionsDir)
                    .Select(Path.GetFileName)
                    .OrderBy(n => n, StringComparer.Ordinal)
                    .ToList();
            }
            catch (IOException) { return new List<string>(); }
            catch (UnauthorizedAccessException) { return new List<string>(); }
        }

        // ================================================================ 主流程

        /// <summary>
        /// 执行更新。任何一步失败都抛 <see cref="LicenseException"/>，且不会动到当前版本。
        /// </summary>
        /// <param name="plan">来自 <see cref="LicenseClient.CheckUpdateAsync"/> 的更新计划</param>
        /// <param name="progress">下载进度，(已下载字节, 总字节)</param>
        /// <param name="allowPostInstall">
        /// 是否执行 post_install。默认关闭：这条命令来自服务端且不在签名保护范围内，
        /// 一旦响应被篡改就等于任意代码执行。
        /// </param>
        /// <param name="restart">安装成功后拉起 launcher（不退出当前进程）</param>
        /// <param name="ct">取消令牌</param>
        public async Task<UpdateResult> ApplyAsync(
            UpdatePlan plan,
            IProgress<(long Received, long Total)> progress = null,
            bool allowPostInstall = false,
            bool restart = false,
            CancellationToken ct = default)
        {
            if (plan == null) throw new ArgumentNullException(nameof(plan));

            if (!plan.Available)
                return new UpdateResult(false, plan.Version, null, skippedReason: "没有可用更新");

            // 平台明确表示安装交给宿主自己处理，SDK 不越俎代庖
            if (plan.InstallStrategy == "notify")
                return new UpdateResult(false, plan.Version, null,
                    skippedReason: "策略为 notify，不自动安装");

            if (string.IsNullOrEmpty(plan.DownloadUrl))
                Fail("更新计划里没有下载地址");

            // 版本号会被拼进路径，先挡掉 ../ 之类的字符再说
            var version = SafeVersion(plan.Version);
            var installed = Path.Combine(VersionsDir, version);
            if (CurrentVersion() == version && Directory.Exists(installed))
                return new UpdateResult(false, plan.Version, installed, skippedReason: "已是该版本");

            var staging = Path.Combine(StagingRoot(),
                "jckami-update-" + Guid.NewGuid().ToString("N").Substring(0, 12));
            Directory.CreateDirectory(staging);

            string target;
            try
            {
                var archive = Path.Combine(staging, "package.bin");
                await DownloadAsync(plan, archive, progress, ct).ConfigureAwait(false);
                Verify(plan, archive);
                target = Install(plan, archive, staging, version);
                Switch(version);
                Prune();
            }
            finally
            {
                TryDeleteDirectory(staging);
            }

            if (allowPostInstall && !string.IsNullOrEmpty(plan.PostInstall))
                RunPostInstall(plan, target);

            var result = new UpdateResult(true, plan.Version, target);
            if (restart) result.Restarted = Restart();
            return result;
        }

        // ================================================================ 各步

        private string StagingRoot()
        {
            var path = Path.Combine(Root, ".updates");
            Directory.CreateDirectory(path);
            return path;
        }

        private async Task DownloadAsync(
            UpdatePlan plan, string target,
            IProgress<(long, long)> progress, CancellationToken ct)
        {
            long received = 0;
            using (var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Get, plan.DownloadUrl))
                    using (var response = await _http
                        .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                        .ConfigureAwait(false))
                    {
                        if (!response.IsSuccessStatusCode)
                            throw new LicenseException(ErrorCode.NetworkUnavailable,
                                $"下载更新包失败：HTTP {(int)response.StatusCode}");

                        var total = plan.FileSize ?? response.Content.Headers.ContentLength ?? 0;

                        using (var source = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                        using (var sink = new FileStream(target, FileMode.Create, FileAccess.Write,
                                                         FileShare.None, DownloadChunk, true))
                        {
                            var buffer = new byte[DownloadChunk];
                            while (true)
                            {
                                var read = await source.ReadAsync(buffer, 0, buffer.Length, ct)
                                    .ConfigureAwait(false);
                                if (read <= 0) break;

                                received += read;
                                // 声明多大就只收多大，避免被超长响应撑爆磁盘
                                if (plan.FileSize.HasValue && received > plan.FileSize.Value)
                                    Fail("下载内容超出声明大小，已中止");

                                await sink.WriteAsync(buffer, 0, read, ct).ConfigureAwait(false);
                                hasher.AppendData(buffer, 0, read);
                                progress?.Report((received, total));
                            }
                        }
                    }
                }
                catch (LicenseException) { throw; }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    // 网络异常种类多，统一转成 SDK 错误
                    Fail("下载更新包失败：" + ex.Message, ErrorCode.NetworkUnavailable);
                }

                if (plan.FileSize.HasValue && received != plan.FileSize.Value)
                    Fail($"下载不完整：期望 {plan.FileSize.Value} 字节，实际 {received} 字节");

                _actualSha256 = DeviceIdentity.ToHex(hasher.GetHashAndReset());
            }
        }

        private void Verify(UpdatePlan plan, string archive)
        {
            var actual = _actualSha256 ?? HashFile(archive);

            if (!string.IsNullOrEmpty(plan.Sha256) &&
                !string.Equals(actual, plan.Sha256, StringComparison.OrdinalIgnoreCase))
                Fail("安装包哈希不匹配，可能已损坏或被篡改");

            if (!plan.Signed)
                Fail("该版本没有签名，拒绝安装。请在后台重新发布以生成签名");

            // FileSize 是签名载荷的一部分，缺了就拼不出正确的待验字符串
            if (!plan.FileSize.HasValue)
                Fail("更新信息缺少 file_size，无法验签");

            // 载荷必须与服务端逐字一致，任何多余的空格都会让验签失败
            var payload = string.Join("\n", new[]
            {
                SignPrefix,
                plan.AppId ?? "",
                plan.Version ?? "",
                actual,
                plan.FileSize.Value.ToString(CultureInfo.InvariantCulture),
            });

            byte[] publicKey, signature;
            try
            {
                publicKey = Convert.FromBase64String(PublicKey);
                signature = Convert.FromBase64String(plan.Signature);
            }
            catch (FormatException)
            {
                Fail("签名或公钥格式非法");
                return;
            }

            if (!Ed25519.Verify(publicKey, Encoding.UTF8.GetBytes(payload), signature))
                Fail("签名验证失败，拒绝安装：这个包不是平台签发的");
        }

        private string Install(UpdatePlan plan, string archive, string staging, string version)
        {
            var unpacked = Path.Combine(staging, "unpacked");

            if (plan.PackageType == "onefile" && !IsZipFile(archive))
            {
                // 单文件形态：包本身就是可执行文件，不需要解压
                Directory.CreateDirectory(unpacked);
                var name = SafeEntryName(plan.Entry) ?? "app.exe";
                File.Copy(archive, Path.Combine(unpacked, name), true);
            }
            else
            {
                ExtractArchive(archive, unpacked, plan.StripRootDir);
            }

            var target = Path.Combine(VersionsDir, version);
            var pending = target + ".pending";

            Directory.CreateDirectory(VersionsDir);
            TryDeleteDirectory(pending);
            Directory.Move(unpacked, pending);

            TryDeleteDirectory(target);
            // rename 是原子的：要么完整出现，要么完全不存在，不会留下半个版本
            Directory.Move(pending, target);
            return target;
        }

        /// <summary>切换指针。先写临时文件再替换，避免写一半掉电导致指针损坏。</summary>
        private void Switch(string version)
        {
            var safe = SafeVersion(version);
            var tmp = PointerPath + ".tmp";

            Directory.CreateDirectory(Root);
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var bytes = Encoding.UTF8.GetBytes(safe);
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);
            }

            if (File.Exists(PointerPath))
            {
                try
                {
                    // File.Replace 是原子的；个别文件系统不支持时退回「删了再挪」
                    File.Replace(tmp, PointerPath, null);
                    return;
                }
                catch (PlatformNotSupportedException) { }
                catch (IOException) { }
                File.Delete(PointerPath);
            }
            File.Move(tmp, PointerPath);
        }

        /// <summary>回滚到某个已安装版本，只是把指针改回去。</summary>
        public string Rollback(string version)
        {
            var target = VersionPath(version);
            if (!Directory.Exists(target))
                Fail($"版本 {version} 未安装，无法回滚");
            Switch(version);
            return target;
        }

        private void Prune()
        {
            var keep = CurrentVersion();
            var versions = InstalledVersions().Where(v => v != keep).ToList();
            // 留最近的几个，其余删掉；保留的用于随时回滚
            var removeCount = Math.Max(0, versions.Count - (KeepVersions - 1));
            for (var i = 0; i < removeCount; i++)
                TryDeleteDirectory(Path.Combine(VersionsDir, versions[i]));
        }

        /// <summary>
        /// 执行安装后命令。
        ///
        /// 默认不开：这条命令来自服务端且不在签名保护范围内，
        /// 一旦响应被篡改就等于任意代码执行。确实需要时由调用方显式打开。
        /// </summary>
        private void RunPostInstall(UpdatePlan plan, string workingDir)
        {
            try
            {
                var isWindows = Path.DirectorySeparatorChar == '\\';
                var psi = new ProcessStartInfo
                {
                    FileName = isWindows ? "cmd.exe" : "/bin/sh",
                    Arguments = isWindows ? "/c " + plan.PostInstall : "-c \"" + plan.PostInstall.Replace("\"", "\\\"") + "\"",
                    WorkingDirectory = workingDir,
                    UseShellExecute = false,
                };
                using (var process = Process.Start(psi))
                {
                    if (process != null && !process.WaitForExit(600_000)) process.Kill();
                }
            }
            catch (Exception ex)
            {
                Fail("安装后命令执行失败：" + ex.Message);
            }
        }

        /// <summary>
        /// 拉起应用根目录下的 launcher。找不到启动器时返回 false，由调用方自行提示用户。
        /// </summary>
        public bool Restart(string launcher = null)
        {
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(launcher)) candidates.Add(launcher);
            foreach (var name in new[] { "launcher.exe", "launcher.bat", "launcher.cmd", "launcher" })
                candidates.Add(Path.Combine(Root, name));

            foreach (var path in candidates)
            {
                if (!File.Exists(path)) continue;
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = path,
                        WorkingDirectory = Root,
                        UseShellExecute = false,
                    });
                    return true;
                }
                catch { /* 换下一个候选 */ }
            }
            return false;
        }

        /// <summary>
        /// 拉起 launcher 后退出当前进程。
        ///
        /// Windows 上运行中的 exe 无法覆盖自己，所以自更新只能是
        /// 「装到新版本目录 → 切指针 → 退出 → 由 launcher 按指针拉起新版本」。
        /// launcher 起不来时返回 false 且不退出，方便调用方提示用户手动重启。
        /// </summary>
        public bool RestartAndExit(string launcher = null, int exitCode = 0)
        {
            if (!Restart(launcher)) return false;
            Environment.Exit(exitCode);
            return true;
        }

        public void Dispose()
        {
            if (_ownsHttp) _http?.Dispose();
        }

        // ================================================================ 解压

        /// <summary>
        /// 算出该剥掉的前缀。
        ///
        /// 只有「所有条目都在同一个顶层目录下」才剥，比如 YourApp/app.exe → app.exe。
        /// 包本身就是平铺的（app.exe 和 _internal/ 并列）时必须原样保留：
        /// 无脑剥一层会把顶层文件整个丢掉，装出来的版本直接跑不起来。
        /// </summary>
        internal static string ResolveStripPrefix(IEnumerable<string> names, bool stripRoot)
        {
            if (!stripRoot) return "";

            var tops = new HashSet<string>(StringComparer.Ordinal);
            foreach (var name in names)
            {
                var rel = name.Replace('\\', '/').Trim('/');
                if (rel.Length == 0) continue;

                var parts = rel.Split('/');
                if (parts.Length == 1) return "";   // 顶层直接有文件，说明没有公共根目录
                tops.Add(parts[0]);
                if (tops.Count > 1) return "";      // 有多个并列的顶层目录，剥了会撞名
            }
            return tops.Count == 1 ? tops.First() + "/" : "";
        }

        /// <summary>
        /// 解压 zip 并阻断路径穿越。
        ///
        /// ZipArchive 不会替你校验条目名，ZipFile.ExtractToDirectory 在老版本 .NET 上
        /// 同样不防 ../。压缩包来自网络，里面完全可能藏着 ../../Windows/System32 这样的条目，
        /// 所以逐个条目算出绝对目标路径，落在 dest 之外的一律拒绝。
        /// </summary>
        internal static void ExtractArchive(string archivePath, string dest, bool stripRoot)
        {
            if (!IsZipFile(archivePath))
                Fail("无法识别的更新包格式，仅支持 zip");

            Directory.CreateDirectory(dest);
            var destRoot = Path.GetFullPath(dest).TrimEnd(Path.DirectorySeparatorChar);

            using (var stream = File.OpenRead(archivePath))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                var prefix = ResolveStripPrefix(zip.Entries.Select(e => e.FullName), stripRoot);

                foreach (var entry in zip.Entries)
                {
                    var rel = entry.FullName.Replace('\\', '/').TrimStart('/');
                    if (prefix.Length > 0)
                    {
                        if (!rel.StartsWith(prefix, StringComparison.Ordinal)) continue;
                        rel = rel.Substring(prefix.Length);
                    }
                    if (rel.Length == 0 || rel == "." || rel == "..") continue;

                    var isDir = rel.EndsWith("/", StringComparison.Ordinal)
                                || string.IsNullOrEmpty(entry.Name);

                    var target = Path.GetFullPath(Path.Combine(destRoot, rel.Replace('/', Path.DirectorySeparatorChar)));
                    if (target != destRoot &&
                        !target.StartsWith(destRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                        Fail("更新包内含越界路径，已中止：" + entry.FullName);

                    if (isDir)
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (var src = entry.Open())
                    using (var dst = new FileStream(target, FileMode.Create, FileAccess.Write,
                                                    FileShare.None, DownloadChunk))
                        src.CopyTo(dst, DownloadChunk);
                }
            }
        }

        private static bool IsZipFile(string path)
        {
            try
            {
                using (var fs = File.OpenRead(path))
                {
                    var head = new byte[4];
                    if (fs.Read(head, 0, 4) != 4) return false;
                    // PK\x03\x04（普通）/ PK\x05\x06（空包）/ PK\x07\x08（分卷）
                    return head[0] == 0x50 && head[1] == 0x4B
                        && (head[2] == 0x03 || head[2] == 0x05 || head[2] == 0x07);
                }
            }
            catch { return false; }
        }

        // ================================================================ 工具

        /// <summary>版本号会被拼进路径，必须挡掉 ../ 之类的字符。</summary>
        internal static string SafeVersion(string version)
        {
            var value = (version ?? "").Trim();
            if (value.Length == 0)
                Fail($"版本号非法：'{version}'");
            foreach (var c in value)
            {
                // 只放行字母数字和 .-_+，路径分隔符、空格、驱动器冒号一律挡掉
                if (!char.IsLetterOrDigit(c) && c != '.' && c != '-' && c != '_' && c != '+')
                    Fail($"版本号非法：'{version}'");
            }
            if (value[0] == '.' || value.IndexOf("..", StringComparison.Ordinal) >= 0)
                Fail($"版本号非法：'{version}'");
            return value;
        }

        /// <summary>entry 同样来自服务端，用作文件名前要剥掉任何路径成分。</summary>
        private static string SafeEntryName(string entry)
        {
            if (string.IsNullOrWhiteSpace(entry)) return null;
            var name = entry.Replace('\\', '/').Split('/').Last().Trim();
            if (name.Length == 0 || name == "." || name == "..") return null;
            return name;
        }

        private static string HashFile(string path)
        {
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(path))
                return DeviceIdentity.ToHex(sha.ComputeHash(fs));
        }

        private static void TryDeleteDirectory(string path)
        {
            try { if (Directory.Exists(path)) Directory.Delete(path, true); }
            catch { /* 清理失败不影响结论 */ }
        }

        private static void Fail(string message, string code = ErrorCode.InternalError)
        {
            throw new LicenseException(code, message);
        }
    }
}
