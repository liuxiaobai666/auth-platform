import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { maskDeviceId } from '../../common/utils/mask.util';
import { normalizePaging } from '../../common/utils/request.util';
import {
  ExportLicenseDto, GenerateLicenseDto, ListLicenseDto, RenewLicenseDto, UnbindDeviceDto,
} from './dto/license.dto';
import { effectiveStatus } from './license-status.util';
import { WEBHOOK_EMIT, WEBHOOK_EVENTS } from '../webhooks/webhook-events';

@Injectable()
export class LicensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventEmitter2,
  ) {}

  /** 发出 webhook 事件。不含卡密原文，只带 id 与必要字段。 */
  private emit(type: string, applicationId: string, data: Record<string, unknown>) {
    this.events.emit(WEBHOOK_EMIT, { applicationId, type, data });
  }

  // ---------------------------------------------------------------- 生成

  async generate(dto: GenerateLicenseDto, adminId: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: dto.plan_id },
      include: { application: true },
    });
    if (!plan) throw AppException.notFound('套餐不存在');
    if (plan.status !== 'active') {
      throw AppException.invalid('该套餐已停用，不能继续发卡');
    }

    const groups = dto.groups ?? 5;
    const batchId = this.crypto.genId('bat');
    const now = new Date();

    // 批内先自查重，再交给数据库唯一索引兜底
    const seen = new Set<string>();
    const plaintexts: string[] = [];
    const rows: Prisma.LicenseKeyCreateManyInput[] = [];

    while (plaintexts.length < dto.count) {
      const plain = this.crypto.generateLicenseKey(groups, 5, dto.prefix);
      const hash = this.crypto.hashLicenseKey(plain);
      if (seen.has(hash)) continue;
      seen.add(hash);
      plaintexts.push(plain);
      rows.push({
        id: this.crypto.genId('lic'),
        applicationId: plan.applicationId,
        planId: plan.id,
        keyHash: hash,
        keyCipher: this.crypto.encrypt(plain),
        keyMasked: this.crypto.maskLicenseKey(plain),
        keyPrefix: this.crypto.licenseKeyPrefix(plain),
        status: 'unused',
        durationDays: dto.duration_days ?? plan.durationDays,
        deviceLimit: dto.device_limit ?? plan.deviceLimit,
        allowRebind: plan.allowRebind,
        rebindLimit: plan.rebindLimit,
        offlineGraceHours: plan.offlineGraceHours,
        batchId,
        note: dto.note ?? null,
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 先落批次元信息，再批量插卡密。批次记录承载渠道标记与聚合视图的锚点。
    await this.prisma.licenseBatch.create({
      data: {
        id: batchId,
        applicationId: plan.applicationId,
        planId: plan.id,
        count: rows.length,
        prefix: dto.prefix ?? null,
        channel: dto.channel ?? null,
        note: dto.note ?? null,
        createdBy: adminId,
      },
    });
    await this.prisma.licenseKey.createMany({ data: rows });

    return {
      batch_id: batchId,
      channel: dto.channel ?? null,
      count: rows.length,
      application_id: plan.applicationId,
      app_id: plan.application.appId,
      plan: { id: plan.id, code: plan.code, name: plan.name },
      // 明文只在这一次响应里返回。之后要拿明文必须走导出接口，且会被审计。
      keys: plaintexts,
    };
  }

  // ---------------------------------------------------------------- 查询

  async list(query: ListLicenseDto) {
    const { page, pageSize, skip, take } = normalizePaging(query.page, query.page_size);

    const where: Prisma.LicenseKeyWhereInput = {
      ...(query.application_id ? { applicationId: query.application_id } : {}),
      ...(query.plan_id ? { planId: query.plan_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.batch_id ? { batchId: query.batch_id } : {}),
      // 前缀搜索走索引列，全程不解密
      ...(query.key_prefix
        ? { keyPrefix: { startsWith: this.crypto.licenseKeyPrefix(query.key_prefix, 16) } }
        : {}),
      // 输入完整卡密时用哈希精确定位
      ...(query.key ? { keyHash: this.crypto.hashLicenseKey(query.key) } : {}),
      ...(query.device_id
        ? { devices: { some: { deviceId: query.device_id, status: 'active' } } }
        : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.licenseKey.count({ where }),
      this.prisma.licenseKey.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: {
          application: { select: { appId: true, name: true } },
          plan: { select: { code: true, name: true } },
          // 只统计仍在绑定中的设备，已解绑的行会保留但不能计入占用数
          _count: { select: { devices: { where: { status: 'active' } } } },
        },
      }),
    ]);

    return { total, page, page_size: pageSize, items: items.map((l) => this.toBrief(l)) };
  }

  async detail(id: string) {
    const license = await this.prisma.licenseKey.findUnique({
      where: { id },
      include: {
        application: { select: { appId: true, name: true } },
        plan: { select: { code: true, name: true } },
        devices: { orderBy: { lastSeenAt: 'desc' } },
      },
    });
    if (!license) throw AppException.notFound('卡密不存在');

    return {
      ...this.toBrief(license),
      devices: license.devices.map((d) => this.deviceDto(d)),
      recent_logs: await this.recentLogs(id),
    };
  }

  private async recentLogs(licenseId: string) {
    const logs = await this.prisma.licenseActivation.findMany({
      where: { licenseId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return logs.map((l) => ({
      action: l.action,
      success: l.success,
      code: l.code,
      device_id: maskDeviceId(l.deviceId),
      ip: l.ip,
      client_version: l.clientVersion,
      created_at: l.createdAt,
    }));
  }

  // ---------------------------------------------------------------- 导出

  /**
   * 导出明文卡密。这是全系统唯一会解密 key_cipher 的地方，
   * 必须由 license:export 权限保护，并写入导出批次与审计日志。
   */
  async exportPlain(dto: ExportLicenseDto, adminId: string, ip: string) {
    if (!dto.batch_id && !dto.ids?.length && !dto.application_id) {
      throw AppException.invalid('导出必须至少指定 batch_id、ids 或 application_id 之一，禁止全量导出');
    }

    const limit = dto.limit ?? 5000;
    const where: Prisma.LicenseKeyWhereInput = {
      ...(dto.batch_id ? { batchId: dto.batch_id } : {}),
      ...(dto.ids?.length ? { id: { in: dto.ids } } : {}),
      ...(dto.application_id ? { applicationId: dto.application_id } : {}),
      ...(dto.status ? { status: dto.status } : {}),
    };

    const items = await this.prisma.licenseKey.findMany({
      where, take: limit, orderBy: { createdAt: 'asc' },
      include: {
        application: { select: { appId: true } },
        plan: { select: { code: true, name: true } },
      },
    });
    if (!items.length) throw AppException.notFound('没有符合条件的卡密');

    await this.prisma.licenseKeyExport.create({
      data: {
        id: this.crypto.genId('exp'),
        adminUserId: adminId,
        applicationId: dto.application_id ?? items[0].applicationId,
        batchId: dto.batch_id ?? null,
        filter: { ...dto } as any,
        count: items.length,
        ip,
      },
    });

    const header = '卡密,应用,套餐,状态,设备上限,有效天数,到期时间,批次号,备注';
    const rows = items.map((l) =>
      [
        this.crypto.decrypt(l.keyCipher),
        l.application.appId,
        `${l.plan.code}(${l.plan.name})`,
        effectiveStatus(l),
        l.deviceLimit,
        l.durationDays ?? '永久',
        l.expiresAt ? l.expiresAt.toISOString() : '',
        l.batchId,
        (l.note ?? '').replace(/[",\n]/g, ' '),
      ].join(','),
    );

    return { count: items.length, csv: [header, ...rows].join('\n') };
  }

  // ---------------------------------------------------------------- 状态变更

  async ban(ids: string[], reason: string) {
    return this.transition(ids, 'banned', reason);
  }

  async revoke(ids: string[], reason: string) {
    return this.transition(ids, 'revoked', reason);
  }

  async unban(ids: string[]) {
    const licenses = await this.prisma.licenseKey.findMany({ where: { id: { in: ids } } });
    if (!licenses.length) throw AppException.notFound('卡密不存在');

    let affected = 0;
    for (const l of licenses) {
      if (l.status !== 'banned') continue;
      // 恢复到激活前后的正确状态：激活过就回 active（过期由 effectiveStatus 兜底），否则回 unused
      const restored = l.activatedAt ? 'active' : 'unused';
      await this.prisma.licenseKey.update({
        where: { id: l.id },
        data: { status: restored as any, bannedAt: null, bannedReason: null },
      });
      affected++;
    }
    return { success: true, affected };
  }

  /**
   * 封禁与作废都要递增 tokenVersion，
   * 否则客户端手里已签发的 license_token 会一直用到自然过期。
   */
  private async transition(ids: string[], status: 'banned' | 'revoked', reason: string) {
    const licenses = await this.prisma.licenseKey.findMany({ where: { id: { in: ids } } });
    if (!licenses.length) throw AppException.notFound('卡密不存在');

    const now = new Date();
    let affected = 0;
    for (const l of licenses) {
      if (l.status === status) continue;
      if (l.status === 'revoked') continue; // 作废是终态，不允许再改
      await this.prisma.licenseKey.update({
        where: { id: l.id },
        data: {
          status: status as any,
          tokenVersion: { increment: 1 },
          ...(status === 'banned'
            ? { bannedAt: now, bannedReason: reason }
            : { revokedAt: now, revokedReason: reason }),
        },
      });
      this.emit(
        status === 'banned' ? WEBHOOK_EVENTS.LICENSE_BANNED : WEBHOOK_EVENTS.LICENSE_REVOKED,
        l.applicationId,
        { license_id: l.id, reason },
      );
      affected++;
    }
    return { success: true, affected, skipped: licenses.length - affected };
  }

  async renew(id: string, dto: RenewLicenseDto) {
    const license = await this.prisma.licenseKey.findUnique({ where: { id } });
    if (!license) throw AppException.notFound('卡密不存在');
    if (license.status === 'revoked') {
      throw new AppException(ErrorCode.LICENSE_REVOKED, '已作废的卡密不能续期');
    }
    if (license.durationDays === null && license.expiresAt === null) {
      throw AppException.invalid('永久卡无需续期');
    }

    // 从当前到期时间和当前时间里取较晚者续期，避免给过期很久的卡密"补时间"
    const base =
      license.expiresAt && license.expiresAt > new Date() ? license.expiresAt : new Date();
    const expiresAt = new Date(base.getTime() + dto.days * 86400_000);

    const updated = await this.prisma.licenseKey.update({
      where: { id },
      data: {
        expiresAt,
        // 过期后续期要恢复成 active，否则验证仍会被拒
        status: license.status === 'expired' ? 'active' : license.status,
      },
    });
    return { success: true, expires_at: updated.expiresAt, status: updated.status };
  }

  // ---------------------------------------------------------------- 设备

  async devices(licenseId: string) {
    const license = await this.prisma.licenseKey.findUnique({
      where: { id: licenseId },
      include: { devices: { orderBy: { lastSeenAt: 'desc' } } },
    });
    if (!license) throw AppException.notFound('卡密不存在');
    return {
      device_limit: license.deviceLimit,
      active_count: license.devices.filter((d) => d.status === 'active').length,
      allow_rebind: license.allowRebind,
      rebind_limit: license.rebindLimit,
      rebind_count: license.rebindCount,
      items: license.devices.map((d) => this.deviceDto(d)),
    };
  }

  /**
   * 管理员强制解绑。默认不计入用户的换绑次数，属于客服兜底手段。
   * 定位设备用的是设备记录主键而不是设备指纹，后台因此不需要接触完整指纹。
   */
  async unbindDevice(licenseId: string, deviceRowId: string, dto: UnbindDeviceDto, operator: string) {
    const device = await this.prisma.licenseDevice.findFirst({
      where: { id: deviceRowId, licenseId },
    });
    if (!device || device.status !== 'active') {
      throw new AppException(ErrorCode.DEVICE_NOT_BOUND, '该设备当前未绑定此卡密');
    }

    await this.prisma.$transaction([
      this.prisma.licenseDevice.update({
        where: { id: device.id },
        data: {
          status: 'unbound',
          unboundAt: new Date(),
          unboundBy: operator,
          unboundReason: dto.reason,
        },
      }),
      this.prisma.licenseKey.update({
        where: { id: licenseId },
        data: {
          // 解绑后该设备手里的令牌必须立即失效
          tokenVersion: { increment: 1 },
          ...(dto.count_as_rebind ? { rebindCount: { increment: 1 } } : {}),
        },
      }),
    ]);

    return { success: true };
  }

  // ---------------------------------------------------------------- 统计

  async stats(applicationId?: string) {
    const where = applicationId ? { applicationId } : {};
    const [byStatus, total, activeDevices, todayActivations] = await Promise.all([
      this.prisma.licenseKey.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.licenseKey.count({ where }),
      this.prisma.licenseDevice.count({
        where: { status: 'active', ...(applicationId ? { licenseKey: { applicationId } } : {}) },
      }),
      this.prisma.licenseActivation.count({
        where: {
          action: 'activate', success: true,
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          ...(applicationId ? { applicationId } : {}),
        },
      }),
    ]);

    const counts: Record<string, number> = {
      unused: 0, active: 0, expired: 0, banned: 0, revoked: 0,
    };
    for (const row of byStatus) counts[row.status] = row._count._all;

    return { total, by_status: counts, active_devices: activeDevices, today_activations: todayActivations };
  }

  // ---------------------------------------------------------------- 映射

  private toBrief(l: any) {
    return {
      id: l.id,
      // 列表页只给脱敏值，任何情况下都不在列表接口返回明文
      key_masked: l.keyMasked,
      key_prefix: l.keyPrefix,
      application_id: l.applicationId,
      app_id: l.application?.appId,
      app_name: l.application?.name,
      plan_id: l.planId,
      plan_code: l.plan?.code,
      plan_name: l.plan?.name,
      status: effectiveStatus(l),
      status_raw: l.status,
      duration_days: l.durationDays,
      is_permanent: l.durationDays === null,
      device_limit: l.deviceLimit,
      device_count: l._count?.devices,
      allow_rebind: l.allowRebind,
      rebind_limit: l.rebindLimit,
      rebind_count: l.rebindCount,
      offline_grace_hours: l.offlineGraceHours,
      batch_id: l.batchId,
      note: l.note,
      activated_at: l.activatedAt,
      expires_at: l.expiresAt,
      banned_reason: l.bannedReason,
      revoked_reason: l.revokedReason,
      created_at: l.createdAt,
    };
  }

  private deviceDto(d: any) {
    return {
      id: d.id,
      // 设备指纹脱敏后再返回，后台没有查看完整指纹的必要
      // 只给脱敏指纹。解绑用上面的 id 定位，后台无需完整指纹
      device_id: maskDeviceId(d.deviceId),
      device_name: d.deviceName,
      client_version: d.clientVersion,
      status: d.status,
      first_seen_at: d.firstSeenAt,
      last_seen_at: d.lastSeenAt,
      last_ip: d.lastIp,
      unbound_at: d.unboundAt,
      unbound_by: d.unboundBy,
      unbound_reason: d.unboundReason,
    };
  }

}
