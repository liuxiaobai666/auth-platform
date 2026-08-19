import { Injectable, Logger } from '@nestjs/common';
import { Application, LicenseKey } from '@prisma/client';
import { Request } from 'express';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PluginPrincipal } from '../../../common/decorators';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { clientIp, userAgent } from '../../../common/utils/request.util';
import { effectiveStatus } from '../../licenses/license-status.util';
import { ConfirmDto, ReleaseDto, ReserveDto } from '../dto/consume.dto';
import { LicenseTokenService } from './license-token.service';
import { PolicyService } from './policy.service';

/** 预扣的默认存活时间：客户端拿到 reservation 后要在这个时间内 confirm/release，否则自动释放。 */
const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;

/**
 * 次数卡的两阶段消费。
 *
 * 额度会计（都在设备行上，每台设备独立）：
 *   可用 = quotaTotal - quotaUsed - quotaReserved
 *   reserve : quotaReserved += amount          （冻结，可用减少）
 *   confirm : quotaReserved -= amount, quotaUsed += amount  （真扣，可用不变）
 *   release : quotaReserved -= amount          （退回，可用恢复）
 *   expire  : 同 release，由定时任务处理
 *
 * 三个防线：
 *   - 幂等键：同一 reservation 幂等键重复 reserve 返回原记录，不重复冻结
 *   - 原子扣减：UPDATE ... WHERE 可用 >= amount，受影响行数=0 即额度不足，天然防并发超扣
 *   - TTL 自动释放：客户端崩溃没 confirm/release，额度不会被永久占住
 */
@Injectable()
export class ConsumeService {
  private readonly logger = new Logger('Consume');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly tokens: LicenseTokenService,
    private readonly policy: PolicyService,
  ) {}

  // ================================================================ 预扣

  async reserve(plugin: PluginPrincipal, dto: ReserveDto, req: Request) {
    const app = await this.resolveApp(plugin, dto.app_id);
    this.policy.assertRunnable(app, undefined, { isActivation: false });

    const { license, device } = await this.locate(app, dto.license_token, dto.device_id);
    if (license.quotaPerDevice === null) {
      throw AppException.invalid('该卡密不是次数卡，无需消费次数');
    }

    const amount = dto.amount ?? 1;
    const idemKey = dto.request_id ?? null;
    const ttl = Math.min(dto.ttl_seconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);

    return this.prisma.$transaction(async (tx) => {
      // 幂等：这个 request_id 已经预扣过就直接返回原结果，不重复冻结
      if (idemKey) {
        const existing = await tx.licenseReservation.findUnique({
          where: { licenseId_idempotencyKey: { licenseId: license.id, idempotencyKey: idemKey } },
        });
        if (existing) {
          const dev = await tx.licenseDevice.findFirst({
            where: { licenseId: license.id, deviceId: dto.device_id },
          });
          return this.reserveResult(existing, dev);
        }
      }

      // 原子冻结：可用额度足够才 +reserved。受影响行数=0 说明不够。
      const affected = await tx.$executeRaw`
        UPDATE license_devices
        SET quotaReserved = quotaReserved + ${amount}
        WHERE id = ${device.id}
          AND quotaTotal IS NOT NULL
          AND (quotaTotal - quotaUsed - quotaReserved) >= ${amount}`;
      if (affected === 0) {
        const fresh = await tx.licenseDevice.findUnique({ where: { id: device.id } });
        const avail = (fresh?.quotaTotal ?? 0) - (fresh?.quotaUsed ?? 0) - (fresh?.quotaReserved ?? 0);
        throw new AppException(
          ErrorCode.QUOTA_EXHAUSTED,
          `本设备剩余次数不足：需要 ${amount}，可用 ${Math.max(0, avail)}`,
          { required: amount, available: Math.max(0, avail) },
        );
      }

      const reservation = await tx.licenseReservation.create({
        data: {
          id: this.crypto.genId('rsv'),
          licenseId: license.id,
          deviceId: dto.device_id,
          amount,
          status: 'reserved',
          idempotencyKey: idemKey,
          expiresAt: new Date(Date.now() + ttl * 1000),
          pluginId: plugin.pluginId,
        },
      });
      const dev = await tx.licenseDevice.findUnique({ where: { id: device.id } });
      await this.log(tx, 'reserve', plugin, req, license.id, dto.device_id, true, null);
      return this.reserveResult(reservation, dev);
    });
  }

  // ================================================================ 确认

  async confirm(plugin: PluginPrincipal, dto: ConfirmDto, req: Request) {
    const app = await this.resolveApp(plugin, dto.app_id);

    return this.prisma.$transaction(async (tx) => {
      const rsv = await tx.licenseReservation.findUnique({ where: { id: dto.reservation_id } });
      if (!rsv) throw AppException.notFound('预扣记录不存在');

      const license = await tx.licenseKey.findUnique({ where: { id: rsv.licenseId } });
      if (!license || license.applicationId !== app.id) throw new AppException(ErrorCode.APP_MISMATCH);

      // 幂等：已确认直接返回成功；已释放/过期不能再确认
      if (rsv.status === 'confirmed') {
        const dev = await tx.licenseDevice.findFirst({ where: { licenseId: rsv.licenseId, deviceId: rsv.deviceId } });
        return this.confirmResult(rsv, dev, true);
      }
      if (rsv.status !== 'reserved') {
        throw new AppException(
          ErrorCode.RESERVATION_NOT_ACTIVE,
          `预扣已${rsv.status === 'released' ? '释放' : '过期'}，无法确认。请重新预扣`,
        );
      }

      // 原子转账：reserved -> used
      await tx.$executeRaw`
        UPDATE license_devices
        SET quotaReserved = quotaReserved - ${rsv.amount},
            quotaUsed = quotaUsed + ${rsv.amount}
        WHERE licenseId = ${rsv.licenseId} AND deviceId = ${rsv.deviceId}`;
      const updated = await tx.licenseReservation.update({
        where: { id: rsv.id },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
      const dev = await tx.licenseDevice.findFirst({ where: { licenseId: rsv.licenseId, deviceId: rsv.deviceId } });
      await this.log(tx, 'confirm', plugin, req, rsv.licenseId, rsv.deviceId, true, null);
      return this.confirmResult(updated, dev, false);
    });
  }

  // ================================================================ 释放

  async release(plugin: PluginPrincipal, dto: ReleaseDto, req: Request) {
    const app = await this.resolveApp(plugin, dto.app_id);

    return this.prisma.$transaction(async (tx) => {
      const rsv = await tx.licenseReservation.findUnique({ where: { id: dto.reservation_id } });
      if (!rsv) throw AppException.notFound('预扣记录不存在');

      const license = await tx.licenseKey.findUnique({ where: { id: rsv.licenseId } });
      if (!license || license.applicationId !== app.id) throw new AppException(ErrorCode.APP_MISMATCH);

      // 幂等：已释放直接返回；已确认不能再释放（次数已经花掉了）
      if (rsv.status === 'released' || rsv.status === 'expired') {
        return { success: true, reservation_id: rsv.id, status: rsv.status };
      }
      if (rsv.status === 'confirmed') {
        throw new AppException(ErrorCode.RESERVATION_NOT_ACTIVE, '预扣已确认扣减，无法释放');
      }

      await this.releaseReservation(tx, rsv);
      await this.log(tx, 'release', plugin, req, rsv.licenseId, rsv.deviceId, true, null);
      return { success: true, reservation_id: rsv.id, status: 'released' };
    });
  }

  /** 把一条 reserved 记录的冻结额度退回，并置为指定终态。 */
  private async releaseReservation(tx: any, rsv: any, status: 'released' | 'expired' = 'released') {
    await tx.$executeRaw`
      UPDATE license_devices
      SET quotaReserved = GREATEST(0, quotaReserved - ${rsv.amount})
      WHERE licenseId = ${rsv.licenseId} AND deviceId = ${rsv.deviceId}`;
    await tx.licenseReservation.update({
      where: { id: rsv.id },
      data: { status, releasedAt: new Date() },
    });
  }

  // ================================================================ 过期释放（定时任务调用）

  async releaseExpired(): Promise<number> {
    const expired = await this.prisma.licenseReservation.findMany({
      where: { status: 'reserved', expiresAt: { lt: new Date() } },
      take: 200,
    });
    let released = 0;
    for (const rsv of expired) {
      await this.prisma
        .$transaction(async (tx) => {
          // 二次确认状态，避免与 confirm 竞态
          const fresh = await tx.licenseReservation.findUnique({ where: { id: rsv.id } });
          if (fresh?.status !== 'reserved') return;
          await this.releaseReservation(tx, fresh, 'expired');
          released++;
        })
        .catch((e) => this.logger.error(`释放过期预扣 ${rsv.id} 失败: ${e.message}`));
    }
    if (released) this.logger.log(`释放了 ${released} 条过期预扣`);
    return released;
  }

  // ================================================================ 内部

  private async resolveApp(plugin: PluginPrincipal, appId: string): Promise<Application> {
    if (appId !== plugin.appId) {
      throw new AppException(ErrorCode.APP_MISMATCH, `插件属于 ${plugin.appId}，不能操作 ${appId}`);
    }
    const app = await this.prisma.application.findUnique({ where: { id: plugin.applicationId } });
    if (!app) throw new AppException(ErrorCode.APP_MISMATCH, '应用不存在');
    return app;
  }

  /** 校验令牌、卡密可用、设备绑定，返回卡密与设备。 */
  private async locate(app: Application, token: string, deviceId: string) {
    const payload = await this.tokens.verifySignature(token);
    if (payload.app !== app.appId) throw new AppException(ErrorCode.APP_MISMATCH);
    if (payload.dev !== deviceId) throw new AppException(ErrorCode.TOKEN_INVALID, '令牌与设备不匹配');

    const license = await this.prisma.licenseKey.findUnique({ where: { id: payload.sub } });
    if (!license) throw new AppException(ErrorCode.LICENSE_NOT_FOUND);
    if (license.applicationId !== app.id) throw new AppException(ErrorCode.APP_MISMATCH);
    if (license.tokenVersion !== payload.ver) throw new AppException(ErrorCode.TOKEN_INVALID, '授权已变更，请重新激活');
    await this.assertUsable(license);

    const device = await this.prisma.licenseDevice.findUnique({
      where: { licenseId_deviceId: { licenseId: license.id, deviceId } },
    });
    if (!device || device.status !== 'active') {
      throw new AppException(ErrorCode.DEVICE_NOT_BOUND, '该设备已解绑，请重新激活');
    }
    return { license, device };
  }

  private async assertUsable(license: LicenseKey) {
    const status = effectiveStatus(license);
    if (status === 'revoked') throw new AppException(ErrorCode.LICENSE_REVOKED, license.revokedReason || undefined);
    if (status === 'banned') throw new AppException(ErrorCode.LICENSE_BANNED, license.bannedReason || undefined);
    if (status === 'expired') throw new AppException(ErrorCode.LICENSE_EXPIRED);
    if (status === 'unused') throw new AppException(ErrorCode.LICENSE_NOT_ACTIVATED);
  }

  private reserveResult(rsv: any, dev: any) {
    const available = dev?.quotaTotal != null
      ? dev.quotaTotal - dev.quotaUsed - dev.quotaReserved
      : null;
    return {
      success: true,
      reservation_id: rsv.id,
      status: rsv.status,
      amount: rsv.amount,
      expires_at: rsv.expiresAt,
      quota_total: dev?.quotaTotal ?? null,
      quota_used: dev?.quotaUsed ?? 0,
      quota_available: available,
    };
  }

  private confirmResult(rsv: any, dev: any, replayed: boolean) {
    return {
      success: true,
      reservation_id: rsv.id,
      status: 'confirmed',
      amount: rsv.amount,
      replayed,
      quota_total: dev?.quotaTotal ?? null,
      quota_used: dev?.quotaUsed ?? 0,
      quota_available: dev?.quotaTotal != null ? dev.quotaTotal - dev.quotaUsed - dev.quotaReserved : null,
    };
  }

  private async log(
    tx: any, action: string, plugin: PluginPrincipal, req: Request,
    licenseId: string, deviceId: string, success: boolean, code: string | null,
  ) {
    await tx.licenseActivation.create({
      data: {
        id: this.crypto.genId('act'),
        licenseId, applicationId: plugin.applicationId, pluginId: plugin.pluginId, deviceId,
        action: 'consume' as any, success, code,
        ip: clientIp(req), userAgent: userAgent(req), requestId: (req as any).requestId ?? null,
      },
    }).catch(() => undefined);
  }
}
