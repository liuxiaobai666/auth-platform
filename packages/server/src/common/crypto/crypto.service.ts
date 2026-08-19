import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * 卡密字符集：去掉了 0/O/1/I/L 等易混淆字符，共 30 个符号。
 * 每字符约 4.9 位熵，默认 5 组 x 5 字符 = 25 字符 ≈ 122 位熵。
 */
const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXY';

@Injectable()
export class CryptoService implements OnModuleInit {
  private masterKey!: Buffer;
  private pepper!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const hex = this.config.get<string>('MASTER_ENCRYPTION_KEY') ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('MASTER_ENCRYPTION_KEY 必须是 64 位十六进制字符串（32 字节）');
    }
    this.masterKey = Buffer.from(hex, 'hex');
    this.pepper = this.config.get<string>('LICENSE_KEY_PEPPER') ?? '';
    if (this.pepper.length < 16) {
      throw new Error('LICENSE_KEY_PEPPER 长度不足，至少 16 个字符');
    }
  }

  // ---------------- 主键 ID ----------------

  /** 生成带前缀的业务 ID，例如 lic_9f2c...，总长不超过 32 字符。 */
  genId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
  }

  randomToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  // ---------------- 可逆加密（AES-256-GCM）----------------

  /** 输出格式：base64( iv(12) | tag(16) | ciphertext )。 */
  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  decrypt(payload: string): string {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  // ---------------- 哈希与签名 ----------------

  sha256(input: string | Buffer): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  hmacSha256(secret: string, payload: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  /** 常量时间比较，避免通过响应时间侧信道推断签名。 */
  safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a ?? '', 'utf8');
    const bufB = Buffer.from(b ?? '', 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  // ---------------- 卡密 ----------------

  /** 规范化：去掉分隔符与空白并转大写，允许用户随手输入小写或漏掉横杠。 */
  normalizeLicenseKey(key: string): string {
    return (key ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  /** 卡密查找与校验用的哈希，掺入服务端 pepper。 */
  hashLicenseKey(key: string): string {
    return crypto
      .createHmac('sha256', this.pepper)
      .update(this.normalizeLicenseKey(key))
      .digest('hex');
  }

  /**
   * 生成卡密明文。使用拒绝采样避免取模带来的字符分布偏斜。
   */
  generateLicenseKey(groups = 5, groupLength = 5, prefix?: string): string {
    const total = groups * groupLength;
    const chars: string[] = [];
    const limit = Math.floor(256 / KEY_ALPHABET.length) * KEY_ALPHABET.length;
    while (chars.length < total) {
      const buf = crypto.randomBytes(total * 2);
      for (const byte of buf) {
        if (byte >= limit) continue;
        chars.push(KEY_ALPHABET[byte % KEY_ALPHABET.length]);
        if (chars.length === total) break;
      }
    }
    const body = Array.from({ length: groups }, (_, i) =>
      chars.slice(i * groupLength, (i + 1) * groupLength).join(''),
    ).join('-');
    return prefix ? `${prefix}-${body}` : body;
  }

  /** 脱敏展示：保留首组与末 4 位，中间打码。 */
  maskLicenseKey(key: string): string {
    const parts = key.split('-');
    if (parts.length <= 2) {
      const n = this.normalizeLicenseKey(key);
      return `${n.slice(0, 4)}****${n.slice(-4)}`;
    }
    const head = parts[0];
    const tail = parts[parts.length - 1];
    const middle = parts.slice(1, -1).map((p) => '*'.repeat(p.length));
    return [head, ...middle, tail].join('-');
  }

  /** 前缀索引：取规范化后的前 N 位，用于后台按前缀搜索。 */
  licenseKeyPrefix(key: string, length = 6): string {
    return this.normalizeLicenseKey(key).slice(0, length);
  }

  /**
   * 稳定分桶，用于灰度放量。同一 (种子, 键) 永远落在同一桶，
   * 保证同一设备不会在放量比例不变时来回横跳。
   */
  stableBucket(seed: string, key: string, buckets = 100): number {
    const digest = crypto.createHash('sha256').update(`${seed}:${key}`).digest();
    return digest.readUInt32BE(0) % buckets;
  }
}
