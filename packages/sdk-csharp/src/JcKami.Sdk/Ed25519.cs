using System;
using System.Collections.Generic;
using System.Numerics;
using System.Security.Cryptography;

namespace JcKami
{
    /// <summary>
    /// Ed25519 验签（RFC 8032）。
    ///
    /// .NET 直到 8.0 都没有内置 Ed25519（10.0 才补上 System.Security.Cryptography.Ed25519），
    /// 而本 SDK 承诺零依赖、且要覆盖 netstandard2.0（.NET Framework 4.6.1+），
    /// 所以这里自带一份实现。验签在整个更新流程里只跑一次，
    /// BigInteger 版的几毫秒完全不影响体验。
    ///
    /// 只实现 verify：客户端永远不需要签名，私钥只存在于服务端。
    /// </summary>
    internal static class Ed25519
    {
        // ---- 曲线参数（RFC 8032 §5.1） ----
        private static readonly BigInteger P =
            BigInteger.Pow(2, 255) - 19;

        private static readonly BigInteger L =
            BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");

        private static readonly BigInteger D = Mod(-121665 * Inv(121666));
        private static readonly BigInteger SqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);

        private static readonly Point B = MakeBasePoint();
        private static readonly Point Identity = new Point(0, 1, 1, 0);

        /// <summary>
        /// 曲线上 8 个小阶点的压缩表示（与 libsodium 的黑名单一致）。
        ///
        /// 用这些点当公钥时，能构造出「对任意消息都验得过」的签名。
        /// 正常流程不会碰到它们，但客户端一旦把公钥读成全零之类的坏值，
        /// 攻击者就能借此让恶意包通过验签 —— 所以宁可直接拒绝。
        /// </summary>
        private static readonly HashSet<string> SmallOrderPoints = new HashSet<string>(StringComparer.Ordinal)
        {
            "0100000000000000000000000000000000000000000000000000000000000000",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000080",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
        };

        /// <summary>验证 Ed25519 签名。publicKey 为裸 32 字节，signature 为 64 字节。</summary>
        public static bool Verify(byte[] publicKey, byte[] message, byte[] signature)
        {
            if (publicKey == null || signature == null || message == null) return false;
            if (publicKey.Length != 32 || signature.Length != 64) return false;
            if (SmallOrderPoints.Contains(DeviceIdentity.ToHex(publicKey))) return false;

            Point a;
            if (!Decompress(publicKey, out a)) return false;

            var rs = new byte[32];
            Buffer.BlockCopy(signature, 0, rs, 0, 32);
            Point r;
            if (!Decompress(rs, out r)) return false;

            var sBytes = new byte[32];
            Buffer.BlockCopy(signature, 32, sBytes, 0, 32);
            var s = FromLittleEndian(sBytes);
            // 拒绝非规范的 S，避免签名可延展
            if (s >= L) return false;

            byte[] hash;
            using (var sha = SHA512.Create())
            {
                var buffer = new byte[32 + 32 + message.Length];
                Buffer.BlockCopy(rs, 0, buffer, 0, 32);
                Buffer.BlockCopy(publicKey, 0, buffer, 32, 32);
                Buffer.BlockCopy(message, 0, buffer, 64, message.Length);
                hash = sha.ComputeHash(buffer);
            }

            var k = Mod(FromLittleEndian(hash), L);

            // 校验 [S]B == R + [k]A
            return PointEqual(ScalarMult(B, s), PointAdd(r, ScalarMult(a, k)));
        }

        // ================================================================ 群运算

        private struct Point
        {
            // 扩展坐标 (X, Y, Z, T)，避免每次加法都求逆元
            public readonly BigInteger X, Y, Z, T;

            public Point(BigInteger x, BigInteger y, BigInteger z, BigInteger t)
            {
                X = x; Y = y; Z = z; T = t;
            }
        }

        private static Point MakeBasePoint()
        {
            var by = Mod(4 * Inv(5));
            BigInteger bx;
            if (!RecoverX(by, 0, out bx))
                throw new InvalidOperationException("Ed25519 基点初始化失败");
            return new Point(bx, by, BigInteger.One, Mod(bx * by));
        }

        private static Point PointAdd(Point p, Point q)
        {
            var a = Mod((p.Y - p.X) * (q.Y - q.X));
            var b = Mod((p.Y + p.X) * (q.Y + q.X));
            var c = Mod(2 * p.T * q.T * D);
            var d = Mod(2 * p.Z * q.Z);
            BigInteger e = b - a, f = d - c, g = d + c, h = b + a;
            return new Point(Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h));
        }

        private static Point ScalarMult(Point p, BigInteger e)
        {
            var q = Identity;
            while (e > 0)
            {
                if (!e.IsEven) q = PointAdd(q, p);
                p = PointAdd(p, p);
                e >>= 1;
            }
            return q;
        }

        private static bool PointEqual(Point p, Point q)
        {
            // 投影坐标下相等要交叉相乘比较，不能直接比 X/Y
            return Mod(p.X * q.Z - q.X * p.Z).IsZero
                && Mod(p.Y * q.Z - q.Y * p.Z).IsZero;
        }

        /// <summary>由 y 与符号位还原 x。返回 false 表示这不是曲线上的点。</summary>
        private static bool RecoverX(BigInteger y, int sign, out BigInteger x)
        {
            x = BigInteger.Zero;
            if (y >= P) return false;

            var xx = Mod((y * y - 1) * BigInteger.ModPow(Mod(D * y * y + 1), P - 2, P));
            if (xx.IsZero) return sign == 0;

            x = BigInteger.ModPow(xx, (P + 3) / 8, P);
            if (!Mod(x * x - xx).IsZero) x = Mod(x * SqrtM1);
            if (!Mod(x * x - xx).IsZero) { x = BigInteger.Zero; return false; }

            if ((x.IsEven ? 0 : 1) != sign) x = P - x;
            return true;
        }

        /// <summary>解压 32 字节点表示。</summary>
        private static bool Decompress(byte[] data, out Point point)
        {
            point = Identity;
            if (data == null || data.Length != 32) return false;

            var raw = new byte[32];
            Buffer.BlockCopy(data, 0, raw, 0, 32);
            var sign = (raw[31] >> 7) & 1;
            raw[31] &= 0x7F;

            var y = FromLittleEndian(raw);
            BigInteger x;
            if (!RecoverX(y, sign, out x)) return false;

            point = new Point(x, y, BigInteger.One, Mod(x * y));
            return true;
        }

        // ================================================================ 工具

        private static BigInteger Inv(BigInteger value) => BigInteger.ModPow(Mod(value), P - 2, P);

        private static BigInteger Mod(BigInteger value) => Mod(value, P);

        private static BigInteger Mod(BigInteger value, BigInteger modulus)
        {
            var r = value % modulus;
            return r.Sign < 0 ? r + modulus : r;
        }

        /// <summary>小端字节序转无符号大整数。</summary>
        private static BigInteger FromLittleEndian(byte[] bytes)
        {
            // BigInteger(byte[]) 按有符号解释，末尾补一个 0 字节才能保证得到正数
            var padded = new byte[bytes.Length + 1];
            Buffer.BlockCopy(bytes, 0, padded, 0, bytes.Length);
            return new BigInteger(padded);
        }
    }
}
