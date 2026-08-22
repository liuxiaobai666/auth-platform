"""Ed25519 验签。

SDK 承诺零依赖，但标准库没有 Ed25519，所以这里按 RFC 8032 自带一份验签实现。
装了 cryptography 就优先用它（更快、经过更多审计），没有就退回纯 Python 实现——
验签在整个更新流程里只跑一次，纯 Python 的几十毫秒完全不影响体验。

只实现 verify：SDK 永远不需要签名，私钥只存在于服务端。
"""

import hashlib

__all__ = ["verify"]

# ---- 曲线参数（RFC 8032 §5.1） ----
_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)
_By = 4 * pow(5, _P - 2, _P) % _P


def _sha512(b):
    return hashlib.sha512(b).digest()


def _recover_x(y, sign):
    """由 y 与符号位还原 x，失败返回 None（表示这不是曲线上的点）。"""
    if y >= _P:
        return None
    xx = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if xx == 0:
        return None if sign else 0
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - xx) % _P != 0:
        return None
    if x % 2 != sign:
        x = _P - x
    return x


_Bx = _recover_x(_By, 0)
# 扩展坐标 (X, Y, Z, T)，避免每次加法都求逆元
_B = (_Bx, _By, 1, _Bx * _By % _P)
_IDENTITY = (0, 1, 1, 0)


def _point_add(p, q):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % _P
    b = (y1 + x1) * (y2 + x2) % _P
    c = 2 * t1 * t2 * _D % _P
    d = 2 * z1 * z2 % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _scalar_mult(p, e):
    q = _IDENTITY
    while e > 0:
        if e & 1:
            q = _point_add(q, p)
        p = _point_add(p, p)
        e >>= 1
    return q


def _point_equal(p, q):
    x1, y1, z1, _ = p
    x2, y2, z2, _ = q
    # 投影坐标下相等要交叉相乘比较，不能直接比 X/Y
    return (x1 * z2 - x2 * z1) % _P == 0 and (y1 * z2 - y2 * z1) % _P == 0


def _decompress(data):
    """解压 32 字节点表示，失败返回 None。"""
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


# 曲线上 8 个小阶点的压缩表示（与 libsodium 的黑名单一致）。
# 用这些点当公钥时，能构造出「对任意消息都验得过」的签名。
# 正常流程不会碰到它们，但客户端一旦把公钥读成全零之类的坏值，
# 攻击者就能借此让恶意包通过验签——所以宁可直接拒绝。
_SMALL_ORDER_POINTS = frozenset(
    bytes.fromhex(h)
    for h in (
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    )
)


def _verify_pure(public_key, message, signature):
    if len(public_key) != 32 or len(signature) != 64:
        return False
    if bytes(public_key) in _SMALL_ORDER_POINTS:
        return False
    a = _decompress(public_key)
    if a is None:
        return False
    rs = signature[:32]
    r = _decompress(rs)
    if r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    # 拒绝非规范的 S，避免签名可延展
    if s >= _L:
        return False
    k = int.from_bytes(_sha512(rs + public_key + message), "little") % _L
    # 校验 [S]B == R + [k]A
    return _point_equal(_scalar_mult(_B, s), _point_add(r, _scalar_mult(a, k)))


def verify(public_key, message, signature):
    """验证 Ed25519 签名。public_key 为裸 32 字节，signature 为 64 字节。"""
    # 前置检查放在分岔之前，保证走 cryptography 和走纯 Python 的结论一致
    if len(public_key) != 32 or len(signature) != 64:
        return False
    if bytes(public_key) in _SMALL_ORDER_POINTS:
        return False
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
            return True
        except (InvalidSignature, ValueError):
            return False
    except ImportError:
        return _verify_pure(public_key, message, signature)
