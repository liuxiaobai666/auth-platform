import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizePaging } from '../../common/utils/request.util';
import { ListBatchDto, UpdateBatchDto } from './dto/batch.dto';

@Injectable()
export class BatchesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 批次列表，每批带核销统计。
   *
   * 核销率 = 已激活(active/expired/banned/revoked，即用过的) / 总数。
   * 这是发卡网预充模式最需要的视图：一眼看出哪批卖得快、哪批还压着货、
   * 哪个渠道的卡异常（比如封禁率特别高 = 可能是盗版渠道）。
   */
  async list(query: ListBatchDto) {
    const { page, pageSize, skip, take } = normalizePaging(query.page, query.page_size);
    const where: Prisma.LicenseBatchWhereInput = {
      ...(query.application_id ? { applicationId: query.application_id } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.keyword
        ? { OR: [{ note: { contains: query.keyword } }, { channel: { contains: query.keyword } }] }
        : {}),
    };

    const [total, batches] = await this.prisma.$transaction([
      this.prisma.licenseBatch.count({ where }),
      this.prisma.licenseBatch.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: {
          application: { select: { appId: true, name: true } },
          plan: { select: { code: true, name: true } },
        },
      }),
    ]);

    // 各批次的卡密状态分布，一次聚合出来，避免 N 次查询
    const ids = batches.map((b) => b.id);
    const grouped = ids.length
      ? await this.prisma.licenseKey.groupBy({
          by: ['batchId', 'status'],
          where: { batchId: { in: ids } },
          _count: { _all: true },
        })
      : [];

    const statOf = (batchId: string) => {
      const rows = grouped.filter((g) => g.batchId === batchId);
      const by: Record<string, number> = { unused: 0, active: 0, expired: 0, banned: 0, revoked: 0 };
      for (const r of rows) by[r.status] = r._count._all;
      const total = Object.values(by).reduce((a, b) => a + b, 0);
      const used = total - by.unused; // 用过的 = 非 unused
      return {
        counts: by,
        total,
        used,
        redemption_rate: total ? Math.round((used / total) * 1000) / 10 : 0,
      };
    };

    return {
      total, page, page_size: pageSize,
      items: batches.map((b) => ({
        id: b.id,
        application_id: b.applicationId,
        app_id: b.application.appId,
        app_name: b.application.name,
        plan_code: b.plan.code,
        plan_name: b.plan.name,
        channel: b.channel,
        prefix: b.prefix,
        note: b.note,
        declared_count: b.count,
        created_at: b.createdAt,
        stats: statOf(b.id),
      })),
    };
  }

  /** 单批详情：状态分布 + 渠道 + 快照。 */
  async detail(id: string) {
    const batch = await this.prisma.licenseBatch.findUnique({
      where: { id },
      include: {
        application: { select: { appId: true, name: true } },
        plan: { select: { code: true, name: true } },
      },
    });
    if (!batch) throw AppException.notFound('批次不存在');

    const grouped = await this.prisma.licenseKey.groupBy({
      by: ['status'], where: { batchId: id }, _count: { _all: true },
    });
    const by: Record<string, number> = { unused: 0, active: 0, expired: 0, banned: 0, revoked: 0 };
    for (const g of grouped) by[g.status] = g._count._all;
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const used = total - by.unused;

    return {
      id: batch.id,
      application_id: batch.applicationId,
      app_id: batch.application.appId,
      app_name: batch.application.name,
      plan_code: batch.plan.code,
      plan_name: batch.plan.name,
      channel: batch.channel,
      prefix: batch.prefix,
      note: batch.note,
      created_at: batch.createdAt,
      stats: { counts: by, total, used, redemption_rate: total ? Math.round((used / total) * 1000) / 10 : 0 },
    };
  }

  async update(id: string, dto: UpdateBatchDto) {
    const batch = await this.prisma.licenseBatch.findUnique({ where: { id } });
    if (!batch) throw AppException.notFound('批次不存在');
    await this.prisma.licenseBatch.update({
      where: { id },
      data: {
        ...(dto.channel !== undefined ? { channel: dto.channel || null } : {}),
        ...(dto.note !== undefined ? { note: dto.note || null } : {}),
      },
    });
    return this.detail(id);
  }

  /** 整批作废：把该批未作废的卡密全部作废（发现整个渠道盗版时用）。 */
  async revokeAll(id: string, reason: string) {
    const batch = await this.prisma.licenseBatch.findUnique({ where: { id } });
    if (!batch) throw AppException.notFound('批次不存在');

    const targets = await this.prisma.licenseKey.findMany({
      where: { batchId: id, status: { not: 'revoked' } },
      select: { id: true },
    });
    const now = new Date();
    let affected = 0;
    for (const t of targets) {
      await this.prisma.licenseKey.update({
        where: { id: t.id },
        // 作废并递增 tokenVersion，让已签发令牌立即失效
        data: { status: 'revoked', revokedAt: now, revokedReason: reason, tokenVersion: { increment: 1 } },
      });
      affected++;
    }
    return { success: true, affected };
  }

  /** 渠道清单，供筛选下拉。 */
  async channels() {
    const rows = await this.prisma.licenseBatch.findMany({
      where: { channel: { not: null } },
      distinct: ['channel'],
      select: { channel: true },
      orderBy: { channel: 'asc' },
    });
    return rows.map((r) => r.channel).filter(Boolean);
  }
}
