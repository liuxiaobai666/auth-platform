import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * 经营看板聚合。
 *
 * 按天聚合用 MySQL 的 DATE(createdAt)。数据以 UTC 字面值存储，所以 DATE() 截出的
 * 是 UTC 日期，读写一致。跨零点的归属以 UTC 为准，前端标注即可。
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 概览卡片：总量、今日、活跃设备、核销率。 */
  async overview(applicationId?: string) {
    const licWhere: Prisma.LicenseKeyWhereInput = applicationId ? { applicationId } : {};
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [byStatus, total, activeDevices, todayNewLicenses, todayActivations] = await Promise.all([
      this.prisma.licenseKey.groupBy({ by: ['status'], where: licWhere, _count: { _all: true } }),
      this.prisma.licenseKey.count({ where: licWhere }),
      this.prisma.licenseDevice.count({
        where: { status: 'active', ...(applicationId ? { licenseKey: { applicationId } } : {}) },
      }),
      this.prisma.licenseKey.count({ where: { ...licWhere, createdAt: { gte: todayStart } } }),
      this.prisma.licenseActivation.count({
        where: {
          action: 'activate', success: true, createdAt: { gte: todayStart },
          ...(applicationId ? { applicationId } : {}),
        },
      }),
    ]);

    const counts: Record<string, number> = { unused: 0, active: 0, expired: 0, banned: 0, revoked: 0 };
    for (const r of byStatus) counts[r.status] = r._count._all;
    const used = total - counts.unused;

    return {
      total_licenses: total,
      by_status: counts,
      redemption_rate: total ? Math.round((used / total) * 1000) / 10 : 0,
      active_devices: activeDevices,
      today_new_licenses: todayNewLicenses,
      today_activations: todayActivations,
    };
  }

  /**
   * 近 N 天趋势：每日激活成功数、每日新增卡密数。
   * 补齐没有数据的日期为 0，前端画折线不会断。
   */
  async trend(days: number, applicationId?: string) {
    const n = Math.min(Math.max(days, 7), 90);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (n - 1));

    const appFilter = applicationId ? Prisma.sql`AND applicationId = ${applicationId}` : Prisma.empty;

    // 每日激活成功数
    const activations = await this.prisma.$queryRaw<{ d: string; c: bigint }[]>`
      SELECT DATE(createdAt) AS d, COUNT(*) AS c
      FROM license_activations
      WHERE action = 'activate' AND success = 1 AND createdAt >= ${since} ${appFilter}
      GROUP BY DATE(createdAt) ORDER BY d`;

    // 每日新增卡密数
    const newLicenses = await this.prisma.$queryRaw<{ d: string; c: bigint }[]>`
      SELECT DATE(createdAt) AS d, COUNT(*) AS c
      FROM license_keys
      WHERE createdAt >= ${since} ${appFilter}
      GROUP BY DATE(createdAt) ORDER BY d`;

    const actMap = new Map(activations.map((r) => [this.dayKey(r.d), Number(r.c)]));
    const newMap = new Map(newLicenses.map((r) => [this.dayKey(r.d), Number(r.c)]));

    const dates: string[] = [];
    const activationSeries: number[] = [];
    const newLicenseSeries: number[] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      dates.push(key);
      activationSeries.push(actMap.get(key) ?? 0);
      newLicenseSeries.push(newMap.get(key) ?? 0);
    }
    return { days: n, dates, activations: activationSeries, new_licenses: newLicenseSeries };
  }

  /** 各应用的卡密数与核销率分布，用于横向对比。 */
  async byApplication() {
    const apps = await this.prisma.application.findMany({
      select: { id: true, appId: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    const grouped = await this.prisma.licenseKey.groupBy({
      by: ['applicationId', 'status'], _count: { _all: true },
    });

    return apps.map((a) => {
      const rows = grouped.filter((g) => g.applicationId === a.id);
      const by: Record<string, number> = { unused: 0, active: 0, expired: 0, banned: 0, revoked: 0 };
      for (const r of rows) by[r.status] = r._count._all;
      const total = Object.values(by).reduce((x, y) => x + y, 0);
      const used = total - by.unused;
      return {
        app_id: a.appId,
        name: a.name,
        total,
        used,
        redemption_rate: total ? Math.round((used / total) * 1000) / 10 : 0,
        by_status: by,
      };
    });
  }

  /** DATE() 返回可能是 Date 或字符串，统一成 YYYY-MM-DD。 */
  private dayKey(d: string | Date): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }
}
