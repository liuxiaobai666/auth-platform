import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis 只承载易失数据：nonce 防重放、限流计数、策略缓存。
 * 这些数据丢了不影响业务正确性，只会短暂放宽防护，因此不入库。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Redis');
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://127.0.0.1:6379/0';
    this.client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    this.client.on('error', (e) => this.logger.error(`Redis 连接错误: ${e.message}`));
    this.client.on('connect', () => this.logger.log('Redis 已连接'));
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
  }

  get raw(): Redis {
    return this.client;
  }

  /**
   * 占位写入。返回 true 表示首次占用，false 表示键已存在。
   * nonce 防重放依赖这个原子性。
   */
  async setNx(key: string, ttlSeconds: number, value = '1'): Promise<boolean> {
    const res = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  /** 固定窗口计数，返回当前窗口内的计数值。 */
  async incrWindow(key: string, windowSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return count;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
    else await this.client.set(key, value);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  async delByPattern(pattern: string): Promise<void> {
    const stream = this.client.scanStream({ match: pattern, count: 200 });
    const pipeline = this.client.pipeline();
    let pending = 0;
    for await (const keys of stream as any as AsyncIterable<string[]>) {
      for (const k of keys) {
        pipeline.del(k);
        pending++;
      }
    }
    if (pending) await pipeline.exec();
  }
}
