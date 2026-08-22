/**
 * 更新包解压：zip / tar / tar.gz，全部用 Node 内置能力实现，SDK 保持零依赖。
 *
 * 这里最要紧的不是解压本身，而是解压时的路径穿越防护：
 * 更新包来自网络，压缩包里一个 ../../ 就能写到应用目录之外。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import * as zlib from 'zlib';
import { LicenseError, LicenseErrorCode } from './errors';

const pipeline = stream.promises.pipeline;

export interface ArchiveEntry {
  name: string;
  isDir: boolean;
  write(target: string): Promise<void>;
}

export interface Archive {
  entries: ArchiveEntry[];
  /** 释放底层文件句柄。无论解压成功还是中途拒绝都必须调用。 */
  close(): void;
}

function fail(message: string): never {
  throw new LicenseError(LicenseErrorCode.INTERNAL_ERROR, message);
}

// ==================================================================== 公共入口

/**
 * 算出该剥掉的前缀。
 *
 * 只有「所有条目都在同一个顶层目录下」才剥，比如 YourApp/app.js → app.js。
 * 包本身就是平铺的（package.json 和 dist/ 并列）时必须原样保留：
 * 无脑剥一层会把顶层文件整个丢掉，装出来的版本直接跑不起来。
 */
export function resolveStripPrefix(names: string[], stripRoot: boolean): string {
  if (!stripRoot) return '';
  const tops = new Set<string>();
  for (const name of names) {
    const rel = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rel) continue;
    const parts = rel.split('/');
    if (parts.length === 1) return ''; // 顶层直接有文件，说明没有公共根目录
    tops.add(parts[0]);
    if (tops.size > 1) return ''; // 有多个并列的顶层目录，剥了会撞名
  }
  return tops.size ? `${[...tops][0]}/` : '';
}

/**
 * 解压并阻断路径穿越。
 *
 * 压缩包来自网络，里面完全可能藏着 ../../../../etc 这样的条目。
 * 逐个成员算出绝对目标路径，落在 dest 之外的一律拒绝。
 */
export async function safeExtract(
  entries: ArchiveEntry[], dest: string, stripPrefix: string,
): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const destRoot = fs.realpathSync(dest);
  for (const entry of entries) {
    let rel = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (stripPrefix) {
      if (!rel.startsWith(stripPrefix)) continue;
      rel = rel.slice(stripPrefix.length);
    }
    if (!rel || rel === '.' || rel === '..') continue;
    const target = path.resolve(destRoot, rel);
    if (target !== destRoot && !target.startsWith(destRoot + path.sep)) {
      fail(`更新包内含越界路径，已中止：${entry.name}`);
    }
    if (entry.isDir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await entry.write(target);
  }
}

/** 识别格式并解压到 dest。 */
export async function extractArchive(
  archive: string, dest: string, stripRoot: boolean,
): Promise<void> {
  const opened = openArchive(archive);
  try {
    const prefix = resolveStripPrefix(opened.entries.map((e) => e.name), stripRoot);
    await safeExtract(opened.entries, dest, prefix);
  } finally {
    opened.close();
  }
}

/** 是否是 zip 包（onefile 形态需要据此判断要不要解压）。 */
export function isZipFile(archive: string): boolean {
  const head = readHead(archive, 4);
  return head.length === 4 && head.readUInt32LE(0) === 0x04034b50;
}

function readHead(archive: string, length: number): Buffer {
  const fd = fs.openSync(archive, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export function openArchive(archive: string): Archive {
  const head = readHead(archive, 512 + 8);
  if (head.length >= 4 && (head.readUInt32LE(0) === 0x04034b50 || head.readUInt32LE(0) === 0x06054b50)) {
    return openZip(archive);
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return { entries: readTarEntries(zlib.gunzipSync(fs.readFileSync(archive))), close: () => {} };
  }
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') {
    return { entries: readTarEntries(fs.readFileSync(archive)), close: () => {} };
  }
  return fail('无法识别的更新包格式，仅支持 zip / tar / tar.gz');
}

// ==================================================================== zip

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  if (got !== length) fail('更新包已损坏：读取长度不足');
  return buf;
}

/** 解析中央目录。只读目录区，条目内容留到写盘时再流式读取。 */
function openZip(archive: string): Archive {
  const fd = fs.openSync(archive, 'r');
  let closed = false;
  const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
  try {
    const size = fs.fstatSync(fd).size;
    // EOCD 在文件末尾，注释最长 65535，所以往回找这么多就够
    const tailLen = Math.min(size, 65535 + 22);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) fail('更新包已损坏：找不到 zip 目录结构');

    let cdOffset = tail.readUInt32LE(eocd + 16);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let count = tail.readUInt16LE(eocd + 10);

    // zip64：字段被 0xFF.. 占位时真实值放在 zip64 尾记录里
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
      const locAbs = size - tailLen + eocd - 20;
      if (locAbs < 0) fail('更新包已损坏：缺少 zip64 定位记录');
      const loc = readAt(fd, locAbs, 20);
      if (loc.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) fail('更新包已损坏：zip64 定位记录非法');
      const z64 = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
      if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) fail('更新包已损坏：zip64 尾记录非法');
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }

    const cd = readAt(fd, cdOffset, cdSize);
    const entries: ArchiveEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CENTRAL_SIG) fail('更新包已损坏：目录项签名非法');
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttrs = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

      // zip64 扩展字段按「哪个字段是 0xFF.. 就补哪个」的顺序排列
      let ep = 0;
      while (ep + 4 <= extra.length) {
        const headerId = extra.readUInt16LE(ep);
        const dataLen = extra.readUInt16LE(ep + 2);
        if (headerId === 0x0001) {
          let q = ep + 4;
          if (cd.readUInt32LE(p + 24) === 0xffffffff) q += 8; // 未压缩大小，用不到
          if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
          break;
        }
        ep += 4 + dataLen;
      }

      p += 46 + nameLen + extraLen + commentLen;

      const isDir = name.endsWith('/') || (((externalAttrs >>> 0) & 0x10) !== 0 && compressedSize === 0);
      entries.push({
        name,
        isDir,
        write: async (target: string) => {
          // 压缩数据的真实位置要看本地头，因为本地头的 extra 长度可能和目录项不同
          const local = readAt(fd, localOffset, 30);
          if (local.readUInt32LE(0) !== LOCAL_SIG) fail('更新包已损坏：本地文件头非法');
          const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
          if (compressedSize === 0) { fs.writeFileSync(target, Buffer.alloc(0)); return; }
          const src = fs.createReadStream('', {
            fd, start: dataStart, end: dataStart + compressedSize - 1, autoClose: false,
          });
          const dst = fs.createWriteStream(target);
          if (method === 0) await pipeline(src, dst);
          else if (method === 8) await pipeline(src, zlib.createInflateRaw(), dst);
          else fail(`更新包使用了不支持的压缩方式：${method}`);
        },
      });
    }
    return { entries, close };
  } catch (e) {
    close();
    throw e;
  }
}

// ==================================================================== tar

/** tar 全部读进内存再解析：更新包体积可控，换来的是代码量小得多。 */
function readTarEntries(buf: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    const rawName = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = off + 512;
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') { // GNU 长文件名
      longName = cstr(buf.subarray(dataStart, dataStart + size));
      continue;
    }
    if (type === '1' || type === '2') { longName = null; continue; } // 链接可指向目录外，直接跳过
    if (type !== '0' && type !== '\0' && type !== '5') { longName = null; continue; }

    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    if (!name) continue;
    const isDir = type === '5' || name.endsWith('/');
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({
      name,
      isDir,
      write: async (target: string) => { fs.writeFileSync(target, data); },
    });
  }
  return entries;
}

function cstr(b: Buffer): string {
  const end = b.indexOf(0);
  return b.subarray(0, end < 0 ? b.length : end).toString('utf8');
}

function parseOctal(b: Buffer): number {
  const text = cstr(b).trim();
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}
