import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizePaging } from '../../common/utils/request.util';
import { CreateEndpointDto, UpdateEndpointDto } from './dto/webhook.dto';

@Injectable()
export class EndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list(applicationId?: string) {
    const items = await this.prisma.webhookEndpoint.findMany({
      where: applicationId ? { applicationId } : {},
      orderBy: { createdAt: 'desc' },
      include: { application: { select: { appId: true, name: true } } },
    });
    return { total: items.length, items: items.map((e) => this.toDto(e)) };
  }

  async create(dto: CreateEndpointDto) {
    const app = await this.prisma.application.findUnique({ where: { id: dto.application_id } });
    if (!app) throw AppException.notFound('应用不存在');

    const secret = `whsec_${this.crypto.randomToken(24)}`;
    const ep = await this.prisma.webhookEndpoint.create({
      data: {
        id: this.crypto.genId('whe'),
        applicationId: dto.application_id,
        url: dto.url,
        secretCipher: this.crypto.encrypt(secret),
        secretMasked: `${secret.slice(0, 10)}****${secret.slice(-4)}`,
        events: dto.events && dto.events.length ? (dto.events as any) : null,
      },
      include: { application: { select: { appId: true, name: true } } },
    });
    // 签名密钥明文只在创建时返回一次
    return { ...this.toDto(ep), secret };
  }

  async update(id: string, dto: UpdateEndpointDto) {
    const ep = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!ep) throw AppException.notFound('Webhook 不存在');
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.events !== undefined ? { events: dto.events.length ? (dto.events as any) : null } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
      include: { application: { select: { appId: true, name: true } } },
    });
    return this.toDto(updated);
  }

  async remove(id: string) {
    const ep = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!ep) throw AppException.notFound('Webhook 不存在');
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { success: true };
  }

  async revealSecret(id: string) {
    const ep = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!ep) throw AppException.notFound('Webhook 不存在');
    return { secret: this.crypto.decrypt(ep.secretCipher) };
  }

  /** 投递记录，带分页与状态筛选。 */
  async deliveries(query: { endpoint_id?: string; status?: string; page?: number; page_size?: number }) {
    const { page, pageSize, skip, take } = normalizePaging(query.page, query.page_size);
    const where = {
      ...(query.endpoint_id ? { endpointId: query.endpoint_id } : {}),
      ...(query.status ? { status: query.status as any } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.count({ where }),
      this.prisma.webhookDelivery.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      total, page, page_size: pageSize,
      items: items.map((d) => ({
        id: d.id,
        event_id: d.eventId,
        event_type: d.eventType,
        status: d.status,
        attempts: d.attempts,
        max_attempts: d.maxAttempts,
        last_status_code: d.lastStatusCode,
        last_error: d.lastError,
        next_retry_at: d.nextRetryAt,
        delivered_at: d.deliveredAt,
        created_at: d.createdAt,
        payload: d.payload,
      })),
    };
  }

  private toDto(e: any) {
    return {
      id: e.id,
      application_id: e.applicationId,
      app_id: e.application?.appId,
      app_name: e.application?.name,
      url: e.url,
      secret_masked: e.secretMasked,
      events: e.events ?? null,
      enabled: e.enabled,
      created_at: e.createdAt,
    };
  }
}
