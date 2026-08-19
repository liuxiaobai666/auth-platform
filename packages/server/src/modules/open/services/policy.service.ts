import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Application } from '@prisma/client';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { compareVersion } from '../../../common/utils/version.util';

export interface PolicyContext {
  clientVersion?: string;
  deviceId?: string;
  channel?: 'stable' | 'beta';
}

/**
 * 远程管控策略的计算与下发。
 *
 * 这里是「远程升级和关停」的服务端实现：客户端每次验证都会拿到最新策略，
 * 由服务端决定它能不能继续跑、要不要升级、升到哪个版本。
 * 所有判断都在服务端做，客户端只负责执行。
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 硬性准入检查。任何一条不通过都直接终止请求，
   * 不给客户端「继续用着再说」的机会。
   */
  assertRunnable(app: Application, clientVersion?: string, opts?: { isActivation?: boolean }) {
    if (app.status !== 'active') {
      throw new AppException(ErrorCode.APP_DISABLED, '应用已停用');
    }
    if (app.killSwitch) {
      throw new AppException(
        ErrorCode.APP_KILLED,
        app.killMessage || '该应用已被远程关停，请联系服务提供方',
      );
    }
    // 维护模式只拦新激活，已激活设备的验证仍然放行，避免维护窗口内全员掉线
    if (app.maintenance && opts?.isActivation) {
      throw new AppException(
        ErrorCode.APP_MAINTENANCE,
        app.maintenanceMessage || '系统维护中，暂停新卡激活',
      );
    }
    if (app.minVersion && clientVersion && compareVersion(clientVersion, app.minVersion) < 0) {
      throw new AppException(
        ErrorCode.CLIENT_VERSION_TOO_LOW,
        app.upgradeMessage || `客户端版本过低，最低需要 ${app.minVersion}`,
        { min_version: app.minVersion, current_version: clientVersion },
      );
    }
  }

  /** 生成下发给客户端的完整策略。 */
  async build(app: Application, ctx: PolicyContext) {
    const release = await this.pickRelease(app, ctx);
    const belowMin =
      !!app.minVersion && !!ctx.clientVersion && compareVersion(ctx.clientVersion, app.minVersion) < 0;
    const hasNewer =
      !!release && !!ctx.clientVersion && compareVersion(ctx.clientVersion, release.version) < 0;

    return {
      app_status: app.status,
      kill_switch: app.killSwitch,
      kill_message: app.killSwitch ? app.killMessage : null,
      maintenance: app.maintenance,
      maintenance_message: app.maintenance ? app.maintenanceMessage : null,
      min_version: app.minVersion,
      upgrade: {
        // required 为真表示不升级就不能继续用
        required: belowMin || (hasNewer && (app.forceUpgrade || !!release?.isMandatory)),
        available: hasNewer,
        latest_version: release?.version ?? app.latestVersion ?? null,
        message: app.upgradeMessage,
        download_url: release ? this.downloadUrl(release) : null,
        file_size: release?.fileSize ? Number(release.fileSize) : null,
        sha256: release?.sha256 ?? null,
        release_notes: release?.releaseNotes ?? null,
        mandatory: !!release?.isMandatory,
      },
      notice: app.noticeEnabled
        ? {
            level: app.noticeLevel,
            title: app.noticeTitle,
            content: app.noticeContent,
          }
        : null,
      policy_ttl_seconds: app.policyTtlSeconds,
      server_time: new Date().toISOString(),
    };
  }

  /**
   * 挑选该客户端应当看到的版本。
   *
   * 灰度用设备指纹做稳定分桶：同一设备在放量比例不变时永远落在同一个桶，
   * 不会出现「刷新一下就提示升级、再刷新又不提示」的抖动。
   * 未命中灰度的设备会回退到上一个 100% 放量的版本。
   */
  private async pickRelease(app: Application, ctx: PolicyContext) {
    const channel = ctx.channel === 'beta' ? 'beta' : 'stable';
    const candidates = await this.prisma.appRelease.findMany({
      where: { applicationId: app.id, status: 'published', channel: channel as any },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    });
    if (!candidates.length) return null;

    // 版本号从高到低排，避免发布时间与版本号顺序不一致时给出旧版本
    candidates.sort((a, b) => compareVersion(b.version, a.version));

    for (const release of candidates) {
      if (release.rolloutPercent >= 100) return release;
      if (!ctx.deviceId) continue; // 没有设备标识就不参与灰度，只看全量版本
      const bucket = this.crypto.stableBucket(release.id, ctx.deviceId, 100);
      if (bucket < release.rolloutPercent) return release;
    }
    // 灰度都没命中，回退到最新的全量版本
    return candidates.find((r) => r.rolloutPercent >= 100) ?? null;
  }

  private downloadUrl(release: { id: string; externalUrl: string | null }): string {
    if (release.externalUrl) return release.externalUrl;
    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    return `${base}/api/v1/releases/${release.id}/download`;
  }
}
