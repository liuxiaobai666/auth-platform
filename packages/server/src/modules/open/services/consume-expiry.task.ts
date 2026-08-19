import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConsumeService } from './consume.service';

/**
 * 次数卡预扣的过期释放：每分钟扫一次超时未确认的预扣，把冻结额度退回。
 * 这是「客户端崩溃/断网没来得及 confirm/release」的兜底，保证额度不被永久占住。
 */
@Injectable()
export class ConsumeExpiryTask {
  private readonly logger = new Logger('ConsumeExpiry');
  constructor(private readonly consume: ConsumeService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'consume-expiry' })
  async run() {
    await this.consume.releaseExpired().catch((e) =>
      this.logger.error(`释放过期预扣异常: ${e.message}`),
    );
  }
}
