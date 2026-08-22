/**
 * Ed25519 验签。
 *
 * Node 内置 crypto 已有 Ed25519，不需要自己实现曲线运算。
 * 唯一麻烦的是 crypto 只吃 SPKI/DER，而平台下发的是裸 32 字节公钥，
 * 所以这里补上固定的 DER 头再交给 crypto。
 *
 * 只实现 verify：SDK 永远不需要签名，私钥只存在于服务端。
 */
import * as crypto from 'crypto';

/** SPKI 头：SEQUENCE{ SEQUENCE{ OID 1.3.101.112 }, BIT STRING(32 字节) } */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * 曲线上 8 个小阶点的压缩表示（与 libsodium 的黑名单一致）。
 * 用这些点当公钥时，能构造出「对任意消息都验得过」的签名。
 * 正常流程不会碰到它们，但客户端一旦把公钥读成全零之类的坏值，
 * 攻击者就能借此让恶意包通过验签——所以宁可直接拒绝。
 */
const SMALL_ORDER_POINTS = new Set([
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
]);

/** 把裸 32 字节公钥包成 Node 能用的 KeyObject。 */
export function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * 验证 Ed25519 签名。
 *
 * @param publicKey 裸 32 字节公钥
 * @param message   被签名的原文
 * @param signature 64 字节签名
 */
export function verify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (SMALL_ORDER_POINTS.has(publicKey.toString('hex'))) return false;
  try {
    return crypto.verify(null, message, publicKeyFromRaw(publicKey), signature);
  } catch {
    // 公钥不在曲线上、DER 拼装失败等，一律当验签不通过
    return false;
  }
}
