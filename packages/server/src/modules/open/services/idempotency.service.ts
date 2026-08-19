import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';

const RETENTION_HOURS = 24;

/**
 * 幂等键处理，对应 DEVELOPMENT.md 8.6。
 * 作用域是 plugin_id + 接口 + 幂等键：
 *   同键同请求体  -> 直接返回首次结果；
 *   同键不同请求体 -> IDEMPOTENCY_CONFLICT，属于接入方实现缺陷。
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** 命中则返回缓存响应，未命中返回 null 让调用方继续执行业务。 */
  async lookup(
    pluginId: string, endpoint: string, idemKey: string, rawBody: Buffer | undefined,
  ): Promise<unknown | null> {
    const requestHash = this.crypto.sha256(rawBody ?? Buffer.alloc(0));
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { pluginId_endpoint_idemKey: { pluginId, endpoint, idemKey } },
    });
    if (!existing) return null;

    if (existing.expiresAt < new Date()) {
      await this.prisma.idempotencyRecord.delete({ where: { id: existing.id } }).catch(() => undefined);
      return null;
    }
    if (existing.requestHash !== requestHash) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        '相同幂等键已用于内容不同的请求，请为新请求生成新的 Idempotency-Key',
      );
    }
    return JSON.parse(existing.responseBody);
  }

  async save(
    pluginId: string, endpoint: string, idemKey: string,
    rawBody: Buffer | undefined, statusCode: number, response: unknown,
  ): Promise<void> {
    await this.prisma.idempotencyRecord
      .create({
        data: {
          id: this.crypto.genId('idm'),
          pluginId,
          endpoint,
          idemKey,
          requestHash: this.crypto.sha256(rawBody ?? Buffer.alloc(0)),
          statusCode,
          responseBody: JSON.stringify(response),
          expiresAt: new Date(Date.now() + RETENTION_HOURS * 3600_000),
        },
      })
      // 并发下同键可能被另一请求抢先写入，唯一索引冲突视为正常
      .catch(() => undefined);
  }

  async purgeExpired(): Promise<number> {
    const res = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return res.count;
  }
}
