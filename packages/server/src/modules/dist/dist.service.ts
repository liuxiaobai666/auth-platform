import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { effectiveStatus } from '../licenses/license-status.util';
import { UpdateDistSiteDto } from './dto/dist.dto';
import { renderDistPage } from './dist.page';

/** 下载票据有效期。够走完一次下载，又短到转发出去很快就失效。 */
const TICKET_TTL_SECONDS = 600;

export interface DownloadTarget {
  file: string;
  fileName: string;
}

@Injectable()
export class DistService {
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {
    const configured = this.config.get<string>('RELEASE_STORAGE_DIR') ?? './storage/releases';
    this.storageDir = path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }

  // ---------------------------------------------------------------- 后台配置

  async getConfig(applicationId: string) {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { distSite: true },
    });
    if (!app) throw AppException.notFound('应用不存在');
    return this.toDto(app.distSite, app.appId);
  }

  async updateConfig(applicationId: string, dto: UpdateDistSiteDto) {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { distSite: true },
    });
    if (!app) throw AppException.notFound('应用不存在');

    // slug 决定对外链接，默认跟 app_id 走，但允许改成更好看的名字
    const slug = (dto.slug ?? app.distSite?.slug ?? app.appId).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(slug)) {
      throw AppException.invalid('链接名只能用小写字母、数字、下划线和短横线，2-64 位');
    }
    const taken = await this.prisma.appDistSite.findUnique({ where: { slug } });
    if (taken && taken.applicationId !== applicationId) {
      throw new AppException(ErrorCode.CONFLICT, `链接名「${slug}」已被其他应用占用`);
    }

    const data = {
      slug,
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
      ...(dto.logo_url !== undefined ? { logoUrl: dto.logo_url } : {}),
      ...(dto.intro !== undefined ? { intro: dto.intro } : {}),
      ...(dto.purchase_url !== undefined ? { purchaseUrl: dto.purchase_url } : {}),
      ...(dto.support_qq !== undefined ? { supportQq: dto.support_qq } : {}),
      ...(dto.support_wechat !== undefined ? { supportWechat: dto.support_wechat } : {}),
      ...(dto.support_email !== undefined ? { supportEmail: dto.support_email } : {}),
      ...(dto.require_license !== undefined ? { requireLicense: dto.require_license } : {}),
      ...(dto.show_changelog !== undefined ? { showChangelog: dto.show_changelog } : {}),
    };

    const site = await this.prisma.appDistSite.upsert({
      where: { applicationId },
      create: { id: this.crypto.genId('dst'), applicationId, ...data },
      update: data,
    });
    return this.toDto(site, app.appId);
  }

  // ---------------------------------------------------------------- 对外页面

  /** 渲染下载页。找不到或未启用一律当作不存在，不泄露「这个应用存在但没开」。 */
  async renderPage(slug: string): Promise<string> {
    const site = await this.prisma.appDistSite.findUnique({
      where: { slug: slug.toLowerCase() },
      include: { application: true },
    });
    if (!site || !site.enabled) throw AppException.notFound('页面不存在');

    const releases = await this.prisma.appRelease.findMany({
      where: { applicationId: site.applicationId, status: 'published', channel: 'stable' },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    });
    const latest = releases.find((r) => this.hasInstaller(r)) ?? null;

    return renderDistPage({
      slug: site.slug,
      title: site.title || site.application.name,
      tagline: site.tagline,
      logoUrl: site.logoUrl,
      intro: site.intro,
      purchaseUrl: site.purchaseUrl,
      support: {
        qq: site.supportQq,
        wechat: site.supportWechat,
        email: site.supportEmail,
      },
      requireLicense: site.requireLicense,
      latest: latest
        ? {
            version: latest.version,
            size: latest.installerSize ? Number(latest.installerSize) : null,
            publishedAt: latest.publishedAt,
            notes: latest.releaseNotes,
          }
        : null,
      changelog: site.showChangelog
        ? releases.map((r) => ({
            version: r.version,
            publishedAt: r.publishedAt,
            notes: r.releaseNotes,
          }))
        : [],
    });
  }

  /**
   * 验卡换取下载票据。
   *
   * 只判断卡密本身是否可用，不绑定设备、不消耗名额——下载还没安装，
   * 这时候占用设备名额会让用户白白损失一个额度。
   */
  async unlock(slug: string, licenseKey: string) {
    const site = await this.prisma.appDistSite.findUnique({
      where: { slug: slug.toLowerCase() },
      include: { application: true },
    });
    if (!site || !site.enabled) throw AppException.notFound('页面不存在');

    const release = await this.latestInstaller(site.applicationId);
    if (!release) throw AppException.notFound('暂无可下载的安装包');

    if (site.requireLicense) {
      const key = (licenseKey || '').trim();
      if (!key) throw AppException.invalid('请输入卡密');

      const found = await this.prisma.licenseKey.findUnique({
        where: { keyHash: this.crypto.hashLicenseKey(key) },
      });
      // 卡密不存在、或属于别的应用，一律给同样的提示：
      // 区分开来等于告诉试卡的人「这张卡是真的，只是不属于这里」
      if (!found || found.applicationId !== site.applicationId) {
        throw new AppException(ErrorCode.LICENSE_NOT_FOUND, '卡密无效');
      }
      const status = effectiveStatus(found, new Date());
      if (status === 'revoked') throw new AppException(ErrorCode.LICENSE_REVOKED, '该卡密已作废');
      if (status === 'banned') throw new AppException(ErrorCode.LICENSE_BANNED, '该卡密已被封禁');
      if (status === 'expired') throw new AppException(ErrorCode.LICENSE_EXPIRED, '该卡密已过期');
    }

    return {
      ticket: this.signTicket(site.slug, release.id),
      version: release.version,
      file_name: release.installerName,
      file_size: release.installerSize ? Number(release.installerSize) : null,
      sha256: release.installerSha256,
      expires_in: TICKET_TTL_SECONDS,
    };
  }

  /** 凭票据取安装包。票据过期或被改过一律拒绝。 */
  async resolveDownload(slug: string, ticket: string): Promise<DownloadTarget> {
    const payload = this.verifyTicket(ticket);
    if (!payload || payload.slug !== slug.toLowerCase()) {
      throw new AppException(ErrorCode.FORBIDDEN, '下载链接已失效，请重新验证卡密');
    }

    const release = await this.prisma.appRelease.findUnique({ where: { id: payload.rid } });
    if (!release || release.status !== 'published') throw AppException.notFound('安装包不存在');

    if (release.installerExternalUrl) {
      throw new AppException(ErrorCode.FORBIDDEN, '该版本使用外部下载地址');
    }
    if (!release.installerPath) throw AppException.notFound('安装包不存在');

    const abs = path.resolve(this.storageDir, release.installerPath);
    // 路径来自库里，但仍要挡住越界：一旦有人写坏了这个字段就是任意文件读取
    if (!abs.startsWith(path.resolve(this.storageDir) + path.sep) || !fs.existsSync(abs)) {
      throw AppException.notFound('安装包文件缺失');
    }

    await this.prisma.appDistSite.updateMany({
      where: { slug: payload.slug },
      data: { downloadCount: { increment: 1 } },
    });

    return { file: abs, fileName: release.installerName || path.basename(abs) };
  }

  /** 外链形态的安装包不经过本站，直接把地址给出去。 */
  async externalUrl(slug: string, ticket: string): Promise<string | null> {
    const payload = this.verifyTicket(ticket);
    if (!payload || payload.slug !== slug.toLowerCase()) return null;
    const release = await this.prisma.appRelease.findUnique({ where: { id: payload.rid } });
    return release?.installerExternalUrl ?? null;
  }

  // ---------------------------------------------------------------- 内部

  private hasInstaller(r: { installerPath: string | null; installerExternalUrl: string | null }) {
    return !!(r.installerPath || r.installerExternalUrl);
  }

  private async latestInstaller(applicationId: string) {
    const releases = await this.prisma.appRelease.findMany({
      where: { applicationId, status: 'published', channel: 'stable' },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    });
    return releases.find((r) => this.hasInstaller(r)) ?? null;
  }

  private ticketSecret(): string {
    return this.config.get<string>('LICENSE_TOKEN_SECRET') ?? '';
  }

  private signTicket(slug: string, releaseId: string): string {
    const payload = { slug, rid: releaseId, exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', this.ticketSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  private verifyTicket(ticket: string): { slug: string; rid: string; exp: number } | null {
    try {
      const [body, sig] = String(ticket || '').split('.');
      if (!body || !sig) return null;
      const expect = crypto.createHmac('sha256', this.ticketSecret()).update(body).digest('base64url');
      // 定长比较，避免用 !== 时的时序差被拿来逐字节试探签名
      const a = Buffer.from(sig);
      const b = Buffer.from(expect);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload?.slug || !payload?.rid) return null;
      if (Math.floor(Date.now() / 1000) > Number(payload.exp)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private toDto(site: any, appId: string) {
    if (!site) {
      return {
        enabled: false,
        slug: appId,
        title: null, tagline: null, logo_url: null, intro: null, purchase_url: null,
        support_qq: null, support_wechat: null, support_email: null,
        require_license: true, show_changelog: true, download_count: 0,
        url_path: `/d/${appId}`,
      };
    }
    return {
      enabled: site.enabled,
      slug: site.slug,
      title: site.title,
      tagline: site.tagline,
      logo_url: site.logoUrl,
      intro: site.intro,
      purchase_url: site.purchaseUrl,
      support_qq: site.supportQq,
      support_wechat: site.supportWechat,
      support_email: site.supportEmail,
      require_license: site.requireLicense,
      show_changelog: site.showChangelog,
      download_count: site.downloadCount,
      url_path: `/d/${site.slug}`,
    };
  }
}
