using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace JcKami
{
    /// <summary>
    /// 本地授权状态存储。
    ///
    /// 采用 encrypt-then-MAC：AES-256-CBC 加密后再对 (IV ‖ 密文) 计算 HMAC-SHA256。
    /// 选 CBC+HMAC 而不是 AES-GCM，是因为 AesGcm 在 .NET Framework / netstandard2.0
    /// 上不存在，而存量 Windows 桌面软件大量跑在 .NET Framework 上。
    ///
    /// 密钥由设备指纹派生：文件拷到别的机器解不开，任何手工改动（比如把「上次验证时间」
    /// 往前挪来骗过离线宽限期）都会在校验 MAC 时被发现。
    ///
    /// 这不是为了防逆向 —— 客户端代码永远可被逆向 —— 而是让「改本地文件就能续命」
    /// 这种最低成本的绕过失效。真正的授权判断始终在服务端。
    /// </summary>
    public class SecureStorage
    {
        private const int MacSize = 32;
        private const int IvSize = 16;

        private readonly string _filePath;
        private readonly byte[] _encKey;
        private readonly byte[] _macKey;

        public SecureStorage(string filePath, string deviceId)
        {
            _filePath = filePath;
            _encKey = Derive("jc-kami-enc:" + deviceId);
            _macKey = Derive("jc-kami-mac:" + deviceId);
        }

        private static byte[] Derive(string label)
        {
            using (var sha = SHA256.Create())
                return sha.ComputeHash(Encoding.UTF8.GetBytes(label));
        }

        /// <summary>读取状态。文件不存在返回 null；被改过则抛 LicenseException。</summary>
        public LicenseState Read()
        {
            byte[] raw;
            try
            {
                if (!File.Exists(_filePath)) return null;
                raw = File.ReadAllBytes(_filePath);
            }
            catch
            {
                return null; // 首次运行或无读权限，当作尚未激活
            }

            try
            {
                if (raw.Length < MacSize + IvSize) throw new CryptographicException("文件长度不足");

                var mac = new byte[MacSize];
                Buffer.BlockCopy(raw, 0, mac, 0, MacSize);

                var body = new byte[raw.Length - MacSize];
                Buffer.BlockCopy(raw, MacSize, body, 0, body.Length);

                // 先验 MAC 再解密：对未认证的密文做解密是常见的安全反模式
                using (var hmac = new HMACSHA256(_macKey))
                {
                    if (!FixedTimeEquals(hmac.ComputeHash(body), mac))
                        throw new CryptographicException("MAC 校验失败");
                }

                var iv = new byte[IvSize];
                Buffer.BlockCopy(body, 0, iv, 0, IvSize);
                var cipher = new byte[body.Length - IvSize];
                Buffer.BlockCopy(body, IvSize, cipher, 0, cipher.Length);

                using (var aes = Aes.Create())
                {
                    aes.Key = _encKey;
                    aes.IV = iv;
                    aes.Mode = CipherMode.CBC;
                    aes.Padding = PaddingMode.PKCS7;
                    using (var dec = aes.CreateDecryptor())
                    {
                        var plain = dec.TransformFinalBlock(cipher, 0, cipher.Length);
                        return JsonSerializer.Deserialize<LicenseState>(
                            Encoding.UTF8.GetString(plain));
                    }
                }
            }
            catch
            {
                throw new LicenseException(
                    ErrorCode.LocalStorageTampered,
                    "本地授权文件已损坏或被修改，请重新激活");
            }
        }

        public void Write(LicenseState state)
        {
            var plain = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(state));

            using (var aes = Aes.Create())
            {
                aes.Key = _encKey;
                aes.GenerateIV();
                aes.Mode = CipherMode.CBC;
                aes.Padding = PaddingMode.PKCS7;

                byte[] cipher;
                using (var enc = aes.CreateEncryptor())
                    cipher = enc.TransformFinalBlock(plain, 0, plain.Length);

                var body = new byte[IvSize + cipher.Length];
                Buffer.BlockCopy(aes.IV, 0, body, 0, IvSize);
                Buffer.BlockCopy(cipher, 0, body, IvSize, cipher.Length);

                byte[] mac;
                using (var hmac = new HMACSHA256(_macKey)) mac = hmac.ComputeHash(body);

                var output = new byte[MacSize + body.Length];
                Buffer.BlockCopy(mac, 0, output, 0, MacSize);
                Buffer.BlockCopy(body, 0, output, MacSize, body.Length);

                var dir = Path.GetDirectoryName(Path.GetFullPath(_filePath));
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllBytes(_filePath, output);
            }
        }

        public void Clear()
        {
            try { if (File.Exists(_filePath)) File.Delete(_filePath); }
            catch { /* 本来就不存在或无权限，当作已清除 */ }
        }

        /// <summary>常量时间比较，避免通过比较耗时推断 MAC。</summary>
        private static bool FixedTimeEquals(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            var diff = 0;
            for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
    }
}
