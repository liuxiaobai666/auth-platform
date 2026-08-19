import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatePlanDto, ListPlanDto, UpdatePlanDto } from './dto/plan.dto';

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list(query: ListPlanDto) {
    const items = await this.prisma.plan.findMany({
      where: {
        ...(query.application_id ? { applicationId: query.application_id } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        application: { select: { appId: true, name: true } },
        _count: { select: { licenseKeys: true } },
      },
    });
    return { total: items.length, items: items.map((p) => this.toDto(p)) };
  }

  async detail(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: { application: { select: { appId: true, name: true } }, _count: { select: { licenseKeys: true } } },
    });
    if (!plan) throw AppException.notFound('套餐不存在');
    return this.toDto(plan);
  }

  async create(dto: CreatePlanDto) {
    const app = await this.prisma.application.findUnique({ where: { id: dto.application_id } });
    if (!app) throw AppException.notFound('应用不存在');

    const dup = await this.prisma.plan.findUnique({
      where: { applicationId_code: { applicationId: dto.application_id, code: dto.code } },
    });
    if (dup) throw new AppException(ErrorCode.CONFLICT, `该应用下已存在 code 为「${dto.code}」的套餐`);

    const plan = await this.prisma.plan.create({
      data: {
        id: this.crypto.genId('pln'),
        applicationId: dto.application_id,
        code: dto.code,
        name: dto.name,
        durationDays: dto.duration_days ?? null,
        deviceLimit: dto.device_limit,
        allowRebind: dto.allow_rebind ?? true,
        rebindLimit: dto.rebind_limit ?? null,
        price: dto.price ?? 0,
        offlineGraceHours: dto.offline_grace_hours ?? 72,
        quotaPerDevice: dto.quota_per_device ?? null,
        status: (dto.status ?? 'active') as any,
        sortOrder: dto.sort_order ?? 0,
      },
      include: { application: { select: { appId: true, name: true } } },
    });
    return this.toDto(plan);
  }

  async update(id: string, dto: UpdatePlanDto) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw AppException.notFound('套餐不存在');

    const updated = await this.prisma.plan.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.duration_days !== undefined ? { durationDays: dto.duration_days } : {}),
        ...(dto.device_limit !== undefined ? { deviceLimit: dto.device_limit } : {}),
        ...(dto.allow_rebind !== undefined ? { allowRebind: dto.allow_rebind } : {}),
        ...(dto.rebind_limit !== undefined ? { rebindLimit: dto.rebind_limit } : {}),
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        ...(dto.offline_grace_hours !== undefined ? { offlineGraceHours: dto.offline_grace_hours } : {}),
        ...(dto.quota_per_device !== undefined ? { quotaPerDevice: dto.quota_per_device } : {}),
        ...(dto.status !== undefined ? { status: dto.status as any } : {}),
        ...(dto.sort_order !== undefined ? { sortOrder: dto.sort_order } : {}),
      },
      include: { application: { select: { appId: true, name: true } } },
    });
    // 已生成的卡密在创建时已快照套餐规则，这里改动只影响之后新生成的卡密
    return this.toDto(updated);
  }

  async remove(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: { _count: { select: { licenseKeys: true } } },
    });
    if (!plan) throw AppException.notFound('套餐不存在');
    if (plan._count.licenseKeys > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `该套餐下已生成 ${plan._count.licenseKeys} 个卡密，不能删除。停售请将状态改为 inactive`,
      );
    }
    await this.prisma.plan.delete({ where: { id } });
    return { success: true };
  }

  private toDto(p: any) {
    return {
      id: p.id,
      application_id: p.applicationId,
      app_id: p.application?.appId,
      app_name: p.application?.name,
      code: p.code,
      name: p.name,
      duration_days: p.durationDays,
      is_permanent: p.durationDays === null,
      device_limit: p.deviceLimit,
      allow_rebind: p.allowRebind,
      rebind_limit: p.rebindLimit,
      rebind_unlimited: p.allowRebind && p.rebindLimit === null,
      price: Number(p.price),
      offline_grace_hours: p.offlineGraceHours,
      quota_per_device: p.quotaPerDevice,
      is_count_card: p.quotaPerDevice !== null,
      status: p.status,
      sort_order: p.sortOrder,
      license_count: p._count?.licenseKeys,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    };
  }
}
