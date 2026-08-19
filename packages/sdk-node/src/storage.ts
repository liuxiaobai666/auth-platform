import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LicenseError, LicenseErrorCode } from './errors';

export interface LicenseState {
  licenseId: string;
  licenseToken: string;
  tokenExpiresAt: string;
  expiresAt: string | null;
  offlineGraceHours: number;
  /** 上一次在线验证成功的时间，离线宽限期从这里开始算 */
  lastVerifiedAt: string;
  deviceId: string;
  appId: string;
}

/**
 * 本地授权状态存储。
 *
 * 用 AES-256-GCM 加密，密钥由设备指纹派生：换台机器复制过去也解不开，
 * 认证标签让任何手工改动都会在读取时暴露，而不是被静默采信。
 * 这不是为了防破解 —— 客户端代码永远可被逆向 —— 而是让「改本地文件
 * 就能续命」这种最低成本的绕过失效。真正的授权判断始终在服务端。
 */
export class SecureStorage {
  private readonly key: Buffer;

  constructor(private readonly filePath: string, deviceId: string) {
    this.key = crypto.createHash('sha256').update(`jc-kami-state:${deviceId}`).digest();
  }

  read(): LicenseState | null {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.filePath);
    } catch {
      return null; // 首次运行，尚未激活
    }
    try {
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      return JSON.parse(plain) as LicenseState;
    } catch {
      throw new LicenseError(
        LicenseErrorCode.LOCAL_STORAGE_TAMPERED,
        '本地授权文件已损坏或被修改，请重新激活',
      );
    }
  }

  write(state: LicenseState): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.concat([iv, cipher.getAuthTag(), enc]), { mode: 0o600 });
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // 本来就不存在，当作已清除
    }
  }
}
