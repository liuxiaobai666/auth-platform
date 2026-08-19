import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 设备指纹。
 *
 * 由两部分组成：机器固有特征 + 一份持久化的随机盐。
 * 加盐是为了避免把可反查的硬件信息直接送到服务端 —— 服务端拿到的是
 * 不可逆的哈希，既能稳定区分设备，又不构成硬件信息收集。
 *
 * 盐文件丢失会导致指纹变化，等同于换了台机器，需要用户重新激活或换绑。
 */
export function resolveDeviceId(saltFile: string): string {
  const salt = loadOrCreateSalt(saltFile);
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model ?? 'unknown-cpu',
    String(os.totalmem()),
    primaryMac(),
  ];
  return crypto.createHash('sha256').update(`${salt}|${parts.join('|')}`).digest('hex').slice(0, 48);
}

function primaryMac(): string {
  const interfaces = os.networkInterfaces();
  // 名称排序保证多网卡机器上每次取到同一张卡，指纹才不会漂移
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return info.mac;
      }
    }
  }
  return 'no-mac';
}

function loadOrCreateSalt(saltFile: string): string {
  try {
    const existing = fs.readFileSync(saltFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 文件不存在或不可读，走下面的创建流程
  }
  const salt = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(saltFile), { recursive: true });
  fs.writeFileSync(saltFile, salt, { mode: 0o600 });
  return salt;
}
