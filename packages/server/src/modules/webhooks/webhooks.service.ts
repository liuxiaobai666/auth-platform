import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ALL_WEBHOOK_EVENTS, WEBHOOK_EMIT, WebhookEventPayload } from './webhook-events';

/** 失败重试的退避间隔（秒）。对齐文档：1s、5s、30s、2m、10m、1h。 */
const RETRY_BACKOFF = [1, 5, 30, 120, 600, 3600];

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Webhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * 监听内部事件总线。业务动作 emit 后，为订阅了该事件的每个 endpoint 建一条投递记录，
   * 然后立即尝试一次推送。失败的交给定时任务按退避重试。
   *
   * 用事件总线解耦：业务代码只管 emit，不需要知道 webhook 存在，也不会因为
   * webhook 慢/失败而阻塞激活、封禁这些主流程。
   */
  @OnEvent(WEBHOOK_EMIT, { async: true })
  async handle(event: WebhookEventPayload): Promise<void> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { applicationId: event.applicationId, enabled: true },
    });

    for (const ep of endpoints) {
      // events 为空 = 订阅全部；否则要包含该类型
      const subscribed = !ep.events || (ep.events as string[]).includes(event.type);
      if (!subscribed) continue;

      const eventId = this.crypto.genId('evt');
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          id: this.crypto.genId('whd'),
          endpointId: ep.id,
          eventId,
          eventType: event.type,
          payload: { id: eventId, type: event.type, data: event.data, created_at: new Date().toISOString() } as any,
          status: 'pending',
        },
      });
      // 立即试一次，不阻塞（各 endpoint 互不影响）
      void this.attempt(delivery.id).catch((e) =>
        this.logger.error(`首次投递异常 ${delivery.id}: ${e.message}`),
      );
    }
  }

  /** 执行一次投递尝试。 */
  async attempt(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
    if (!delivery || delivery.status === 'delivered' || delivery.status === 'dead') return;

    const ep = delivery.endpoint;
    const body = JSON.stringify(delivery.payload);
    const secret = this.crypto.decrypt(ep.secretCipher);
    const timestamp = String(Math.floor(Date.now() / 1000));
    // 签名算法与开放 API 一致：HMAC-SHA256(timestamp.body)
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const attempt = delivery.attempts + 1;
    let ok = false;
    let statusCode: number | null = null;
    let error: string | null = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000); // 8 秒超时
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Event-Id': delivery.eventId,
          'X-Event-Type': delivery.eventType,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      statusCode = res.status;
      ok = res.status >= 200 && res.status < 300;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
    }

    if (ok) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'delivered', attempts: attempt, lastStatusCode: statusCode, deliveredAt: new Date(), nextRetryAt: null },
      });
    } else {
      const exhausted = attempt >= delivery.maxAttempts;
      const backoff = RETRY_BACKOFF[Math.min(attempt - 1, RETRY_BACKOFF.length - 1)];
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: exhausted ? 'dead' : 'failed',
          attempts: attempt,
          lastStatusCode: statusCode,
          lastError: error,
          nextRetryAt: exhausted ? null : new Date(Date.now() + backoff * 1000),
        },
      });
      if (exhausted) {
        this.logger.warn(`投递彻底失败进入死信 ${deliveryId} → ${ep.url}: ${error}`);
      }
    }
  }

  /** 定时任务调用：捞出到期该重试的失败投递，逐个再试。 */
  async processRetries(): Promise<number> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'failed', nextRetryAt: { lte: new Date() } },
      take: 100,
      orderBy: { nextRetryAt: 'asc' },
    });
    for (const d of due) {
      await this.attempt(d.id).catch(() => undefined);
    }
    return due.length;
  }

  /** 供业务侧调用的便捷方法：手动重投一条。 */
  async redeliver(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'pending', nextRetryAt: null },
    }).catch(() => undefined);
    await this.attempt(deliveryId);
  }

  static allEvents() {
    return ALL_WEBHOOK_EVENTS;
  }
}
