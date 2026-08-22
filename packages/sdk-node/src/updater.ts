/**
 * 远程更新：下载、验签、解压、原子切换。
 *
 * 设计要点：
 * - 永远不往正在运行的目录里解压。新版本进独立的 versions/<版本>/，
 *   再改一个指针文件切过去，所以中途断电、断网都不会把用户的软件搞成半新半旧。
 * - 装之前必须验 Ed25519 签名。哈希只能防传输损坏，防不了篡改——
 *   能改安装包的人同样能改哈希，只有私钥签的名他伪造不了。
 * - 解压做路径穿越防护。压缩包里一个 ../../ 就能写到目录之外，
 *   而更新包恰恰来自网络，这是必须堵死的口子。
 */
import { spawn, exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractArchive, isZipFile } from './archive';
import * as ed25519 from './ed25519';
import { LicenseError, LicenseErrorCode } from './errors';
import { ApplyOptions, UpdaterOptions, UpgradePolicy } from './types';

export const CURRENT_POINTER = 'current.txt';
const SIGN_PREFIX = 'jc-kami-release-v1';
const DEFAULT_USER_AGENT = 'jc-kami-updater/1.0';

function fail(message: string, code: string = LicenseErrorCode.INTERNAL_ERROR): never {
  throw new LicenseError(code, message);
}

/** 一次更新的完整描述，由 policy 的 upgrade 段解析而来。 */
export class UpdatePlan {
  readonly appId: string;
  readonly available: boolean;
  readonly required: boolean;
  readonly mandatory: boolean;
  version: string | null;
  downloadUrl: string | null;
  sha256: string | null;
  fileSize: number | null;
  signature: string | null;
  readonly releaseNotes: string | null;
  readonly message: string | null;
  readonly packageType: string;
  readonly installStrategy: string;
  readonly stripRootDir: boolean;
  readonly entry: string | null;
  readonly postInstall: string | null;

  constructor(appId: string, upgrade?: Partial<UpgradePolicy> | null) {
    const u = upgrade ?? {};
    const pkg = u.package ?? undefined;
    this.appId = appId;
    this.available = !!u.available;
    this.required = !!u.required;
    this.mandatory = !!u.mandatory;
    this.version = u.latest_version ?? null;
    this.downloadUrl = u.download_url ?? null;
    this.sha256 = u.sha256 ?? null;
    this.fileSize = u.file_size ?? null;
    this.signature = u.signature ?? null;
    this.releaseNotes = u.release_notes ?? null;
    this.message = u.message ?? null;
    this.packageType = pkg?.type || 'zip';
    this.installStrategy = pkg?.install_strategy || 'versioned';
    this.stripRootDir = !!pkg?.strip_root_dir;
    this.entry = pkg?.entry ?? null;
    this.postInstall = pkg?.post_install ?? null;
  }

  /** 有签名才可能装得上，没签名的包 Updater 一定拒绝。 */
  get signed(): boolean {
    return !!this.signature;
  }
}

export interface UpdateResult {
  applied: boolean;
  version: string | null;
  path: string | null;
  restarted: boolean;
  skippedReason?: string;
}

/**
 * 把一次 UpdatePlan 落到磁盘上。
 *
 * 目录结构：
 *   <root>/versions/<版本>/   各版本的实际文件
 *   <root>/current.txt        指向当前版本的指针
 *   <root>/.updates/          下载与解压的临时区
 */
export class Updater {
  readonly root: string;
  readonly publicKey: string;
  readonly keepVersions: number;
  readonly timeout: number;
  /** 下载请求携带的 User-Agent，见 UpdaterOptions.userAgent。 */
  readonly userAgent: string;

  constructor(options: UpdaterOptions) {
    if (!options?.publicKey) {
      fail('必须提供验签公钥：没有它就无法判断安装包是否被篡改');
    }
    this.root = path.resolve(options.root);
    this.publicKey = options.publicKey;
    this.keepVersions = Math.max(1, Math.floor(options.keepVersions ?? 2));
    this.timeout = options.timeout ?? 60_000;
    // 不设的话 Node 的 fetch 会发 `user-agent: node`，Cloudflare 之类的浏览器完整性检查
    // 会直接判成机器人并返回 403，下载根本到不了服务端。
    this.userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT;
  }

  // ---------------------------------------------------------------- 路径

  get versionsDir(): string {
    return path.join(this.root, 'versions');
  }

  get pointerPath(): string {
    return path.join(this.root, CURRENT_POINTER);
  }

  versionPath(version: string): string {
    return path.join(this.versionsDir, Updater.safeVersion(version));
  }

  /** 当前指针指向的版本，没有则返回 null。 */
  currentVersion(): string | null {
    try {
      return fs.readFileSync(this.pointerPath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  installedVersions(): string[] {
    try {
      return fs.readdirSync(this.versionsDir)
        .filter((n) => fs.statSync(path.join(this.versionsDir, n)).isDirectory())
        .sort();
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- 主流程

  /** 执行更新。任何一步失败都抛 LicenseError，且不会动到当前版本。 */
  async apply(plan: UpdatePlan, options: ApplyOptions = {}): Promise<UpdateResult> {
    if (!plan.available) {
      return { applied: false, version: plan.version, path: null, restarted: false, skippedReason: '没有可用更新' };
    }
    if (plan.installStrategy === 'notify') {
      // 平台明确表示安装交给宿主自己处理（Electron 有自己的 autoUpdater），SDK 不越俎代庖
      return {
        applied: false, version: plan.version, path: null, restarted: false,
        skippedReason: '策略为 notify，不自动安装',
      };
    }
    if (!plan.downloadUrl) fail('更新计划里没有下载地址');
    const version = Updater.safeVersion(plan.version);
    const target = this.versionPath(version);
    if (this.currentVersion() === version && isDir(target)) {
      return { applied: false, version, path: target, restarted: false, skippedReason: '已是该版本' };
    }

    const staging = fs.mkdtempSync(path.join(this.stagingRoot(), 'jckami-update-'));
    const archive = path.join(staging, 'package.bin');
    let installed: string;
    try {
      const actualSha = await this.download(plan, archive, options.progress);
      this.verify(plan, actualSha, version);
      installed = await this.install(plan, archive, staging, version);
      this.switchTo(version);
      this.prune();
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }

    if (options.allowPostInstall && plan.postInstall) {
      await this.runPostInstall(plan.postInstall, installed);
    }

    const result: UpdateResult = { applied: true, version, path: installed, restarted: false };
    if (options.restart) result.restarted = this.restart();
    return result;
  }

  /** 回滚到某个已安装版本，只是把指针改回去。 */
  rollback(version: string): string {
    const target = this.versionPath(version);
    if (!isDir(target)) fail(`版本 ${version} 未安装，无法回滚`);
    this.switchTo(Updater.safeVersion(version));
    return target;
  }

  /** 重启到新版本。找不到启动器时返回 false，由调用方自行提示用户。 */
  restart(launcher?: string): boolean {
    const candidates = [
      ...(launcher ? [launcher] : []),
      ...['launcher.exe', 'launcher', 'launcher.js', 'launcher.cmd']
        .map((n) => path.join(this.root, n)),
    ];
    for (const file of candidates) {
      if (!isFile(file)) continue;
      try {
        const child = file.endsWith('.js')
          ? spawn(process.execPath, [file], { cwd: this.root, detached: true, stdio: 'ignore' })
          : spawn(file, [], { cwd: this.root, detached: true, stdio: 'ignore' });
        child.unref();
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- 各步

  private stagingRoot(): string {
    const dir = path.join(this.root, '.updates');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 流式下载，边写盘边算哈希。返回实际内容的 sha256。 */
  private async download(
    plan: UpdatePlan, target: string, progress?: (received: number, total: number) => void,
  ): Promise<string> {
    const digest = crypto.createHash('sha256');
    let received = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const out = fs.createWriteStream(target);

    try {
      const res = await fetch(plan.downloadUrl!, {
        signal: controller.signal,
        headers: { 'User-Agent': this.userAgent, Accept: '*/*' },
      });
      if (res.status === 403) {
        // 多半不是服务端拒绝，而是前面的 CDN/WAF 把非浏览器请求拦了
        fail(
          '下载安装包被拒绝（HTTP 403）。若域名走了 CDN/WAF（如 Cloudflare），'
          + '请放行 /api/v1/releases/*/download，或关闭对非浏览器 User-Agent 的拦截。',
          LicenseErrorCode.NETWORK_UNAVAILABLE,
        );
      }
      if (!res.ok) fail(`下载更新包失败：HTTP ${res.status}`, LicenseErrorCode.NETWORK_UNAVAILABLE);

      const declared = plan.fileSize ?? 0;
      const header = Number(res.headers.get('content-length') ?? 0);
      // 服务端自己报的长度就和声明的对不上，说明拿到的根本不是这个包
      if (declared && header && header !== declared) {
        fail(`下载长度与声明不符：声明 ${declared} 字节，服务端返回 ${header} 字节`);
      }
      const total = declared || header;

      if (!res.body) fail('下载更新包失败：响应没有内容', LicenseErrorCode.NETWORK_UNAVAILABLE);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        // 声明多大就只收多大，避免被超长响应撑爆磁盘
        if (declared && received > declared) {
          await reader.cancel().catch(() => undefined);
          fail('下载内容超出声明大小，已中止');
        }
        digest.update(chunk);
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
        progress?.(received, total);
      }
    } catch (e) {
      if (e instanceof LicenseError) throw e;
      // 网络异常种类多，统一转成 SDK 错误
      fail(`下载更新包失败：${(e as Error).message}`, LicenseErrorCode.NETWORK_UNAVAILABLE);
    } finally {
      clearTimeout(timer);
      await new Promise<void>((resolve) => out.end(resolve));
    }

    if (plan.fileSize && received !== plan.fileSize) {
      fail(`下载不完整：期望 ${plan.fileSize} 字节，实际 ${received} 字节`);
    }
    return digest.digest('hex');
  }

  /** 先比哈希，再验签名。两关都过才允许往磁盘上装。 */
  private verify(plan: UpdatePlan, actualSha: string, version: string): void {
    if (plan.sha256 && actualSha !== plan.sha256) {
      fail('安装包哈希不匹配，可能已损坏或被篡改');
    }
    if (!plan.signature) {
      fail('该版本没有签名，拒绝安装。请在后台重新发布以生成签名');
    }
    if (plan.fileSize === null || plan.fileSize === undefined) {
      // fileSize 是签名载荷的一部分，缺了就拼不出正确的待验字符串
      fail('更新信息缺少 file_size，无法验签');
    }

    const payload = Buffer.from(
      [SIGN_PREFIX, plan.appId, version, actualSha, String(plan.fileSize)].join('\n'),
      'utf8',
    );
    let publicKey: Buffer;
    let signature: Buffer;
    try {
      publicKey = Buffer.from(this.publicKey, 'base64');
      signature = Buffer.from(plan.signature, 'base64');
    } catch {
      fail('签名或公钥格式非法');
    }
    if (!ed25519.verify(publicKey, payload, signature)) {
      fail('签名验证失败，拒绝安装：这个包不是平台签发的');
    }
  }

  private async install(
    plan: UpdatePlan, archive: string, staging: string, version: string,
  ): Promise<string> {
    const unpacked = path.join(staging, 'unpacked');
    if (plan.packageType === 'onefile' && !isZipFile(archive)) {
      // 单文件形态：包本身就是可执行文件，不需要解压
      fs.mkdirSync(unpacked, { recursive: true });
      const name = path.basename(plan.entry || 'app.exe');
      fs.copyFileSync(archive, path.join(unpacked, name));
    } else {
      await extractArchive(archive, unpacked, plan.stripRootDir);
    }

    const target = path.join(this.versionsDir, version);
    const pending = `${target}.pending`;
    fs.rmSync(pending, { recursive: true, force: true });
    fs.mkdirSync(this.versionsDir, { recursive: true });
    fs.renameSync(unpacked, pending);

    fs.rmSync(target, { recursive: true, force: true });
    // rename 是原子的：要么完整出现，要么完全不存在，不会留下半个版本
    fs.renameSync(pending, target);
    return target;
  }

  /** 切换指针。先写临时文件再替换，避免写一半掉电导致指针损坏。 */
  private switchTo(version: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.pointerPath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, version);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.pointerPath);
  }

  private prune(): void {
    const keep = this.currentVersion();
    const versions = this.installedVersions().filter((v) => v !== keep);
    // 留最近的几个，其余删掉；保留的用于随时回滚
    const drop = Math.max(0, versions.length - (this.keepVersions - 1));
    for (const name of versions.slice(0, drop)) {
      fs.rmSync(path.join(this.versionsDir, name), { recursive: true, force: true });
    }
  }

  /**
   * 执行安装后命令。
   *
   * 默认不开：这条命令来自服务端且不在签名保护范围内，
   * 一旦响应被篡改就等于任意代码执行。确实需要时由调用方显式打开。
   */
  private runPostInstall(command: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd, timeout: 600_000 }, (err) => {
        // 命令本身返回非零不算失败（对齐 Python 版 check=False），只有起不来才报错
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          reject(new LicenseError(LicenseErrorCode.INTERNAL_ERROR, `安装后命令执行失败：${err.message}`));
          return;
        }
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------- 工具

  /** 版本号会被拼进路径，必须挡掉 ../ 之类的字符。 */
  static safeVersion(version: string | null | undefined): string {
    const value = String(version ?? '').trim();
    if (!value || !/^[A-Za-z0-9.\-_+]+$/.test(value)) fail(`版本号非法：${JSON.stringify(version)}`);
    if (value.startsWith('.') || value.includes('..')) fail(`版本号非法：${JSON.stringify(version)}`);
    if (path.isAbsolute(value) || value !== path.basename(value)) {
      fail(`版本号非法：${JSON.stringify(version)}`);
    }
    return value;
  }

  /** 计算本地文件的 sha256，用于自检。 */
  static hashFile(file: string): string {
    const digest = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        digest.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return digest.digest('hex');
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
