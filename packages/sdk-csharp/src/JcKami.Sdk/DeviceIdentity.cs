using System;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;

namespace JcKami
{
    /// <summary>
    /// 设备指纹。
    ///
    /// 由机器固有特征加上一份持久化随机盐哈希而成。加盐是为了不把可反查的硬件信息
    /// 直接送到服务端：服务端拿到的是不可逆哈希，既能稳定区分设备，也不构成硬件信息收集。
    ///
    /// 盐文件丢失会导致指纹变化，等同于换了台机器，需要重新激活或换绑。
    /// 所以盐文件应放在用户数据目录，而不是临时目录。
    /// </summary>
    public static class DeviceIdentity
    {
        /// <summary>生成本机稳定指纹，返回 48 位十六进制字符串。</summary>
        public static string Resolve(string saltFilePath)
        {
            var salt = LoadOrCreateSalt(saltFilePath);
            var parts = new[]
            {
                SafeGet(() => Environment.MachineName),
                SafeGet(() => Environment.OSVersion.Platform.ToString()),
                SafeGet(() => Environment.ProcessorCount.ToString()),
                SafeGet(() => RuntimeArchitecture()),
                PrimaryMacAddress(),
            };

            using (var sha = SHA256.Create())
            {
                var raw = salt + "|" + string.Join("|", parts);
                var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(raw));
                return ToHex(hash).Substring(0, 48);
            }
        }

        private static string RuntimeArchitecture()
        {
#if NETSTANDARD2_0
            return IntPtr.Size == 8 ? "x64" : "x86";
#else
            return System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString();
#endif
        }

        /// <summary>
        /// 取第一块可用物理网卡的 MAC。
        /// 按名称排序保证多网卡机器每次取到同一块，指纹才不会漂移；
        /// 跳过回环与虚拟网卡，它们在不同环境下会变。
        /// </summary>
        private static string PrimaryMacAddress()
        {
            try
            {
                var nic = NetworkInterface.GetAllNetworkInterfaces()
                    .Where(n => n.NetworkInterfaceType != NetworkInterfaceType.Loopback
                                && n.NetworkInterfaceType != NetworkInterfaceType.Tunnel
                                && n.GetPhysicalAddress().GetAddressBytes().Length == 6)
                    .OrderBy(n => n.Id, StringComparer.Ordinal)
                    .FirstOrDefault();

                if (nic == null) return "no-mac";
                var bytes = nic.GetPhysicalAddress().GetAddressBytes();
                return bytes.All(b => b == 0) ? "no-mac" : ToHex(bytes);
            }
            catch
            {
                return "no-mac";
            }
        }

        private static string LoadOrCreateSalt(string saltFilePath)
        {
            try
            {
                if (File.Exists(saltFilePath))
                {
                    var existing = File.ReadAllText(saltFilePath, Encoding.UTF8).Trim();
                    if (existing.Length >= 32) return existing;
                }
            }
            catch
            {
                // 文件损坏或无读权限，走下面的重建流程
            }

            var salt = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(salt);
            var text = ToHex(salt);

            var dir = Path.GetDirectoryName(Path.GetFullPath(saltFilePath));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(saltFilePath, text, new UTF8Encoding(false));
            return text;
        }

        private static string SafeGet(Func<string> getter)
        {
            try { return getter() ?? "unknown"; }
            catch { return "unknown"; }
        }

        internal static string ToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }
}
