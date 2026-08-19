import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Application, LicenseKey } from '@prisma/client';
import { Request } from 'express';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PluginPrincipal } from '../../../common/decorators';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { clientIp, userAgent } from '../../../common/utils/request.util';
import { effectiveStatus } from '../../licenses/license-status.util';
import { WEBHOOK_EMIT, WEBHOOK_EVENTS } from '../../webhooks/webhook-events';
import { ActivateDto, DeactivateDto, VerifyDto } from '../dto/open.dto';
import { LicenseTokenService } from './license-token.service';
import { PolicyService } from './policy.service';

type Action = 'activate' | 'verify' | 'deactivate' | 'status' | 'policy';

@Injectable()
export class ActivationService {
  private readonly logger = new Logger('Activation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly tokens: LicenseTokenService,
    private readonly policy: PolicyService,
    private readonly events: EventEmitter2,
  ) {}

  private emit(type: string, applicationId: string, data: Record<string, unknown>) {
    this.events.emit(WEBHOOK_EMIT, { applicationId, type, data });
  }

  // ================================================================ 激活

  async activate(plugin: PluginPrincipal, dto: ActivateDto, req: Request) {
    return this.logged('activate', plugin, req, dto.device_id, dto.client_version, async () => {
      const app = await this.resolveApp(plugin, dto.app_id);
      this.policy.assertRunnable(app, dto.client_version, { isActivation: true });

      const keyHash = this.crypto.hashLicenseKey(dto.license_key);
      const found = await this.prisma.licenseKey.findUnique({ where: { keyHash } });
      if (!found) throw new AppException(ErrorCode.LICENSE_NOT_FOUND);
      if (found.applicationId !== app.id) {
        // 卡密属于别的应用，绝不能跨应用激活
        throw new AppException(ErrorCode.APP_MISMATCH);
      }

      const result = await this.bindDevice(found.id, app, dto, req).catch(async (e) => {
        // 事务已回滚，此时才是安全的落库时机
        if (e instanceof AppException && e.code === ErrorCode.LICENSE_EXPIRED) {
          await this.markExpired(found.id);
        }
        throw e;
      });

      const { token, expiresAt: tokenExpiresAt } = await this.tokens.sign({
        licenseId: result.license.id,
        appId: app.appId,
        deviceId: dto.device_id,
        planId: result.license.planId,
        tokenVersion: result.license.tokenVersion,
      });

      // 首次激活发 activated，重复激活(已绑定设备)不重复发；新设备加入发 device_bound
      if (result.firstActivation) {
        this.emit(WEBHOOK_EVENTS.LICENSE_ACTIVATED, app.id, {
          license_id: result.license.id, device_count: result.deviceCount,
        });
      } else if (result.newDevice) {
        this.emit(WEBHOOK_EVENTS.DEVICE_BOUND, app.id, {
          license_id: result.license.id, device_count: result.deviceCount,
        });
      }

      return {
        licenseId: result.license.id,
        body: {
          success: true,
          license_id: result.license.id,
          status: 'active',
          activated_at: result.license.activatedAt,
          expires_at: result.license.expiresAt,
          is_permanent: result.license.expiresAt === null,
          device_limit: result.license.deviceLimit,
          device_count: result.deviceCount,
          allow_rebind: result.license.allowRebind,
          rebind_limit: result.license.rebindLimit,
          rebind_remaining:
            result.license.rebindLimit === null
              ? null
              : Math.max(0, result.license.rebindLimit - result.license.rebindCount),
          offline_grace_hours: result.license.offlineGraceHours,
          license_token: token,
          token_expires_at: tokenExpiresAt,
          policy: await this.policy.build(app, {
            clientVersion: dto.client_version,
            deviceId: dto.device_id,
            channel: dto.channel,
          }),
        },
      };
    });
  }

  /**
   * 设备绑定。整段跑在事务里，并对卡密行加 FOR UPDATE 排它锁。
   *
   * 只靠「先查数量再插入」在并发下必然超卖：两个请求可能同时读到
   * device_count = 0 然后各插一条，把 device_limit=1 的卡密绑上两台机器。
   * 行锁把同一张卡密的绑定操作串行化，(license_id, device_id) 唯一索引兜底。
   */
  private async bindDevice(licenseId: string, app: Application, dto: ActivateDto, req: Request) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM license_keys WHERE id = ${licenseId} FOR UPDATE`;

      const license = await tx.licenseKey.findUniqueOrThrow({ where: { id: licenseId } });
      const now = new Date();
      const status = effectiveStatus(license, now);

      if (status === 'revoked') throw new AppException(ErrorCode.LICENSE_REVOKED, license.revokedReason || undefined);
      if (status === 'banned') throw new AppException(ErrorCode.LICENSE_BANNED, license.bannedReason || undefined);
      // 注意：这里不能顺手把状态落库。整段跑在事务里，抛异常会连同这次
      // 更新一起回滚，状态永远写不进去。落库交给调用方在事务外做。
      if (status === 'expired') throw new AppException(ErrorCode.LICENSE_EXPIRED);

      const isFirstActivation = license.status === 'unused';
      const expiresAt = isFirstActivation
        ? license.durationDays === null
          ? null
          : new Date(now.getTime() + license.durationDays * 86400_000)
        : license.expiresAt;

      const existing = await tx.licenseDevice.findUnique({
        where: { licenseId_deviceId: { licenseId, deviceId: dto.device_id } },
      });

      if (existing?.status === 'active') {
        // 同一设备重复激活是幂等的，不占新名额也不算换绑
        await tx.licenseDevice.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            lastIp: clientIp(req),
            clientVersion: dto.client_version ?? existing.clientVersion,
            deviceName: dto.device_name ?? existing.deviceName,
          },
        });
      } else {
        const activeCount = await tx.licenseDevice.count({
          where: { licenseId, status: 'active' },
        });
        if (activeCount >= license.deviceLimit) {
          throw new AppException(
            ErrorCode.DEVICE_LIMIT_EXCEEDED,
            `该卡密最多绑定 ${license.deviceLimit} 台设备，当前已绑定 ${activeCount} 台`,
            { device_limit: license.deviceLimit, device_count: activeCount },
          );
        }

        if (existing) {
          // 之前解绑过的设备重新绑回来，复用原行以保留首次绑定时间
          await tx.licenseDevice.update({
            where: { id: existing.id },
            data: {
              status: 'active',
              lastSeenAt: now,
              lastIp: clientIp(req),
              clientVersion: dto.client_version ?? null,
              deviceName: dto.device_name ?? existing.deviceName,
              unboundAt: null, unboundBy: null, unboundReason: null,
            },
          });
        } else {
          await tx.licenseDevice.create({
            data: {
              id: this.crypto.genId('dev'),
              licenseId,
              deviceId: dto.device_id,
              deviceName: dto.device_name ?? null,
              clientVersion: dto.client_version ?? null,
              status: 'active',
              // 次数卡：新设备从卡密的每设备额度快照一份独立额度
              quotaTotal: license.quotaPerDevice,
              firstSeenAt: now,
              lastSeenAt: now,
              lastIp: clientIp(req),
            },
          });
        }
      }

      const updated = await tx.licenseKey.update({
        where: { id: licenseId },
        data: {
          status: 'active',
          ...(isFirstActivation ? { activatedAt: now, expiresAt } : {}),
        },
      });

      const deviceCount = await tx.licenseDevice.count({ where: { licenseId, status: 'active' } });
      // firstActivation：卡密从未激活变为激活；newDevice：这次新增了一台设备绑定
      const newDevice = !existing || existing.status !== 'active';
      return { license: updated, deviceCount, firstActivation: isFirstActivation, newDevice };
    });
  }

  // ================================================================ 验证

  async verify(plugin: PluginPrincipal, dto: VerifyDto, req: Request) {
    return this.logged('verify', plugin, req, dto.device_id, dto.client_version, async () => {
      const app = await this.resolveApp(plugin, dto.app_id);
      // 维护模式不拦已激活设备的验证，避免维护窗口内全员掉线
      this.policy.assertRunnable(app, dto.client_version, { isActivation: false });

      const payload = await this.tokens.verifySignature(dto.license_token);
      if (payload.app !== app.appId) throw new AppException(ErrorCode.APP_MISMATCH);
      if (payload.dev !== dto.device_id) {
        throw new AppException(ErrorCode.TOKEN_INVALID, '授权令牌与当前设备不匹配');
      }
      if (await this.tokens.isRevoked(payload.jti)) {
        throw new AppException(ErrorCode.TOKEN_INVALID, '授权令牌已被撤销');
      }

      const license = await this.prisma.licenseKey.findUnique({ where: { id: payload.sub } });
      if (!license) throw new AppException(ErrorCode.LICENSE_NOT_FOUND);
      if (license.applicationId !== app.id) throw new AppException(ErrorCode.APP_MISMATCH);
      // 封禁、作废、解绑都会递增 tokenVersion，这一步让旧令牌立即失效
      if (license.tokenVersion !== payload.ver) {
        throw new AppException(ErrorCode.TOKEN_INVALID, '授权已变更，请重新激活');
      }

      await this.assertLicenseUsable(license);

      const device = await this.prisma.licenseDevice.findUnique({
        where: { licenseId_deviceId: { licenseId: license.id, deviceId: dto.device_id } },
      });
      if (!device || device.status !== 'active') {
        throw new AppException(ErrorCode.DEVICE_NOT_BOUND, '该设备已被解绑，请重新激活');
      }

      await this.prisma.licenseDevice.update({
        where: { id: device.id },
        data: {
          lastSeenAt: new Date(),
          lastIp: clientIp(req),
          clientVersion: dto.client_version ?? device.clientVersion,
        },
      });

      // 令牌滚动续期：每次验证都换发新令牌，缩短单个令牌的暴露窗口
      const { token, expiresAt: tokenExpiresAt } = await this.tokens.sign({
        licenseId: license.id,
        appId: app.appId,
        deviceId: dto.device_id,
        planId: license.planId,
        tokenVersion: license.tokenVersion,
      });

      return {
        licenseId: license.id,
        body: {
          success: true,
          license_id: license.id,
          status: 'active',
          expires_at: license.expiresAt,
          is_permanent: license.expiresAt === null,
          offline_grace_hours: license.offlineGraceHours,
          license_token: token,
          token_expires_at: tokenExpiresAt,
          policy: await this.policy.build(app, {
            clientVersion: dto.client_version,
            deviceId: dto.device_id,
            channel: dto.channel,
          }),
        },
      };
    });
  }

  // ================================================================ 解绑

  /**
   * 客户端主动解绑，也就是「换绑」动作本身。
   * 换绑次数在这里计数：用户每把授权从一台机器上摘下来一次就消耗一次配额，
   * 之后绑到新机器属于正常绑定，不再重复扣减。
   */
  async deactivate(plugin: PluginPrincipal, dto: DeactivateDto, req: Request) {
    return this.logged('deactivate', plugin, req, dto.device_id, undefined, async () => {
      const app = await this.resolveApp(plugin, dto.app_id);
      this.policy.assertRunnable(app, undefined, { isActivation: false });

      const license = await this.locateLicense(app, dto.license_token, dto.license_key);

      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM license_keys WHERE id = ${license.id} FOR UPDATE`;
        const fresh = await tx.licenseKey.findUniqueOrThrow({ where: { id: license.id } });

        const device = await tx.licenseDevice.findUnique({
          where: { licenseId_deviceId: { licenseId: fresh.id, deviceId: dto.device_id } },
        });
        if (!device || device.status !== 'active') {
          throw new AppException(ErrorCode.DEVICE_NOT_BOUND);
        }
        if (!fresh.allowRebind) {
          throw new AppException(ErrorCode.REBIND_NOT_ALLOWED, '当前套餐不允许自助解绑换绑');
        }
        if (fresh.rebindLimit !== null && fresh.rebindCount >= fresh.rebindLimit) {
          throw new AppException(
            ErrorCode.REBIND_LIMIT_EXCEEDED,
            `换绑次数已用尽（上限 ${fresh.rebindLimit} 次），请联系客服处理`,
            { rebind_limit: fresh.rebindLimit, rebind_count: fresh.rebindCount },
          );
        }

        await tx.licenseDevice.update({
          where: { id: device.id },
          data: {
            status: 'unbound',
            unboundAt: new Date(),
            unboundBy: `plugin:${plugin.pluginId}`,
            unboundReason: dto.reason ?? '客户端主动解绑',
          },
        });

        const updated = await tx.licenseKey.update({
          where: { id: fresh.id },
          data: {
            rebindCount: { increment: 1 },
            // 解绑后该设备手上的令牌必须立刻失效，不能等自然过期
            tokenVersion: { increment: 1 },
          },
        });

        const deviceCount = await tx.licenseDevice.count({
          where: { licenseId: fresh.id, status: 'active' },
        });
        return { updated, deviceCount };
      });

      this.emit(WEBHOOK_EVENTS.DEVICE_UNBOUND, app.id, {
        license_id: license.id, device_count: result.deviceCount,
      });

      return {
        licenseId: license.id,
        body: {
          success: true,
          license_id: license.id,
          device_count: result.deviceCount,
          device_limit: result.updated.deviceLimit,
          rebind_count: result.updated.rebindCount,
          rebind_remaining:
            result.updated.rebindLimit === null
              ? null
              : Math.max(0, result.updated.rebindLimit - result.updated.rebindCount),
        },
      };
    });
  }

  // ================================================================ 状态查询

  async status(plugin: PluginPrincipal, appId: string, licenseId: string | undefined,
               licenseKey: string | undefined, deviceId: string | undefined, req: Request) {
    return this.logged('status', plugin, req, deviceId, undefined, async () => {
      const app = await this.resolveApp(plugin, appId);

      let license: LicenseKey | null = null;
      if (licenseId) {
        license = await this.prisma.licenseKey.findUnique({ where: { id: licenseId } });
      } else if (licenseKey) {
        license = await this.prisma.licenseKey.findUnique({
          where: { keyHash: this.crypto.hashLicenseKey(licenseKey) },
        });
      } else {
        throw AppException.invalid('必须提供 license_id 或 license_key');
      }
      if (!license) throw new AppException(ErrorCode.LICENSE_NOT_FOUND);
      if (license.applicationId !== app.id) throw new AppException(ErrorCode.APP_MISMATCH);

      const [deviceCount, thisDevice] = await Promise.all([
        this.prisma.licenseDevice.count({ where: { licenseId: license.id, status: 'active' } }),
        deviceId
          ? this.prisma.licenseDevice.findUnique({
              where: { licenseId_deviceId: { licenseId: license.id, deviceId } },
            })
          : Promise.resolve(null),
      ]);

      return {
        licenseId: license.id,
        body: {
          success: true,
          license_id: license.id,
          // 状态查询只回状态，不签发令牌，也不返回卡密明文和完整设备指纹
          status: effectiveStatus(license),
          activated_at: license.activatedAt,
          expires_at: license.expiresAt,
          is_permanent: license.durationDays === null,
          device_limit: license.deviceLimit,
          device_count: deviceCount,
          device_bound: thisDevice?.status === 'active',
          allow_rebind: license.allowRebind,
          rebind_limit: license.rebindLimit,
          rebind_count: license.rebindCount,
          offline_grace_hours: license.offlineGraceHours,
        },
      };
    });
  }

  /** 不带卡密的纯策略拉取，供客户端在未激活时也能收到关停和升级指令。 */
  async policyOnly(plugin: PluginPrincipal, appId: string, clientVersion: string | undefined,
                   deviceId: string | undefined, channel: 'stable' | 'beta' | undefined, req: Request) {
    return this.logged('policy', plugin, req, deviceId, clientVersion, async () => {
      const app = await this.resolveApp(plugin, appId);
      const policy = await this.policy.build(app, { clientVersion, deviceId, channel });
      return { licenseId: undefined, body: { success: true, policy } };
    });
  }

  // ================================================================ 内部

  private async resolveApp(plugin: PluginPrincipal, appId: string): Promise<Application> {
    // 以插件绑定的应用为准，请求体里的 app_id 只用于交叉校验
    if (appId !== plugin.appId) {
      throw new AppException(
        ErrorCode.APP_MISMATCH,
        `插件 ${plugin.pluginId} 属于应用 ${plugin.appId}，不能操作 ${appId}`,
      );
    }
    const app = await this.prisma.application.findUnique({ where: { id: plugin.applicationId } });
    if (!app) throw new AppException(ErrorCode.APP_MISMATCH, '应用不存在');
    return app;
  }

  private async locateLicense(app: Application, token?: string, key?: string): Promise<LicenseKey> {
    if (token) {
      const payload = await this.tokens.verifySignature(token);
      if (payload.app !== app.appId) throw new AppException(ErrorCode.APP_MISMATCH);
      const license = await this.prisma.licenseKey.findUnique({ where: { id: payload.sub } });
      if (!license) throw new AppException(ErrorCode.LICENSE_NOT_FOUND);
      if (license.applicationId !== app.id) throw new AppException(ErrorCode.APP_MISMATCH);
      return license;
    }
    if (key) {
      const license = await this.prisma.licenseKey.findUnique({
        where: { keyHash: this.crypto.hashLicenseKey(key) },
      });
      if (!license) throw new AppException(ErrorCode.LICENSE_NOT_FOUND);
      if (license.applicationId !== app.id) throw new AppException(ErrorCode.APP_MISMATCH);
      return license;
    }
    throw AppException.invalid('必须提供 license_token 或 license_key');
  }

  private async assertLicenseUsable(license: LicenseKey) {
    const status = effectiveStatus(license);
    if (status === 'revoked') throw new AppException(ErrorCode.LICENSE_REVOKED, license.revokedReason || undefined);
    if (status === 'banned') throw new AppException(ErrorCode.LICENSE_BANNED, license.bannedReason || undefined);
    if (status === 'expired') {
      await this.markExpired(license.id);
      throw new AppException(ErrorCode.LICENSE_EXPIRED);
    }
    if (status === 'unused') throw new AppException(ErrorCode.LICENSE_NOT_ACTIVATED);
  }

  /**
   * 把「时间上已过期但数据库还写着 active」的卡密状态补齐。
   * 必须在事务之外调用：拒绝请求要靠抛异常，而抛异常会回滚同一事务里的写入。
   */
  private async markExpired(licenseId: string) {
    await this.prisma.licenseKey
      .updateMany({
        where: { id: licenseId, status: 'active' },
        data: { status: 'expired' },
      })
      .catch(() => undefined);
  }

  /**
   * 统一记录授权日志。成功和失败都要留痕，
   * 失败时把错误码一并落库，方便排查「为什么用户激活不了」。
   */
  private async logged<T extends { licenseId?: string; body: unknown }>(
    action: Action, plugin: PluginPrincipal, req: Request,
    deviceId: string | undefined, clientVersion: string | undefined,
    fn: () => Promise<T>,
  ): Promise<unknown> {
    try {
      const result = await fn();
      await this.writeLog(action, plugin, req, deviceId, clientVersion, result.licenseId, true, null, null);
      return result.body;
    } catch (e) {
      const code = e instanceof AppException ? e.code : ErrorCode.INTERNAL_ERROR;
      const message = e instanceof Error ? e.message : String(e);
      await this.writeLog(action, plugin, req, deviceId, clientVersion, undefined, false, code, message);
      if (!(e instanceof AppException)) {
        this.logger.error(`${action} 处理异常: ${message}`, (e as Error).stack);
      }
      throw e;
    }
  }

  private async writeLog(
    action: Action, plugin: PluginPrincipal, req: Request,
    deviceId: string | undefined, clientVersion: string | undefined,
    licenseId: string | undefined, success: boolean, code: string | null, message: string | null,
  ) {
    await this.prisma.licenseActivation
      .create({
        data: {
          id: this.crypto.genId('act'),
          licenseId: licenseId ?? null,
          applicationId: plugin.applicationId,
          pluginId: plugin.pluginId,
          deviceId: deviceId ?? null,
          action,
          success,
          code,
          message: message?.slice(0, 255) ?? null,
          clientVersion: clientVersion ?? null,
          ip: clientIp(req),
          userAgent: userAgent(req),
          requestId: (req as any).requestId ?? null,
        },
      })
      .catch(() => undefined);
  }
}
