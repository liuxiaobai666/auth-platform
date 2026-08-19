import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhooksService } from './webhooks.service';

/**
 * Webhook 重试定时任务：每分钟捞一次到期该重试的失败投递。
 * 退避间隔由投递记录的 nextRetryAt 控制，这里只负责按时唤醒。
 */
@Injectable()
export class WebhookRetryTask {
  private readonly logger = new Logger('WebhookRetry');
  constructor(private readonly webhooks: WebhooksService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'webhook-retry' })
  async run() {
    const n = await this.webhooks.processRetries();
    if (n > 0) this.logger.log(`重试了 ${n} 条 webhook 投递`);
  }
}
