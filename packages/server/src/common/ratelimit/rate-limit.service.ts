import { Injectable } from '@nestjs/common';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { RedisService } from '../redis/redis.service';

export interface RateRule {
  /** 维度名，用于组装 Redis 键，例如 ip / plugin / license / device */
  dimension: string;
  key: string;
  limit: number;
  windowSeconds: number;
}

/**
 * 固定窗口限流。文档 8.6 要求按插件、卡密、设备和来源 IP 分别计数，
 * 任一维度超限即拒绝，并返回 Retry-After。
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  async consume(scope: string, rules: RateRule[]): Promise<void> {
    for (const rule of rules) {
      if (!rule.key || rule.limit <= 0) continue;
      const redisKey = `rl:${scope}:${rule.dimension}:${rule.key}`;
      const count = await this.redis.incrWindow(redisKey, rule.windowSeconds);
      if (count > rule.limit) {
        const ttl = await this.redis.ttl(redisKey);
        throw new AppException(
          ErrorCode.RATE_LIMITED,
          `请求过于频繁（${rule.dimension} 维度），请稍后再试`,
          { retry_after: ttl > 0 ? ttl : rule.windowSeconds, dimension: rule.dimension },
        );
      }
    }
  }

  /** 登录失败等场景需要能主动清零。 */
  async reset(scope: string, dimension: string, key: string): Promise<void> {
    await this.redis.del(`rl:${scope}:${dimension}:${key}`);
  }

  /**
   * 只读检查，不自增。当前计数已达到或超过 limit 就拦截。
   * 配合 penalize 使用：penalize 负责自增，gate 只负责按当前值判断。
   */
  async gate(scope: string, dimension: string, key: string, limit: number): Promise<void> {
    if (!key || limit <= 0) return;
    const current = Number((await this.redis.get(`rl:${scope}:${dimension}:${key}`)) ?? 0);
    if (current >= limit) {
      const ttl = await this.redis.ttl(`rl:${scope}:${dimension}:${key}`);
      throw new AppException(
        ErrorCode.RATE_LIMITED,
        '失败尝试过多，请稍后再试',
        { retry_after: ttl > 0 ? ttl : 300, dimension },
      );
    }
  }

  /**
   * 只加计数、不做拦截判断。用于「先放行、事后按结果回填惩罚」的场景：
   * 比如激活时先执行，发现卡密不存在再回来给这个 IP 记一笔，
   * 下次 consume 时这笔就会被算进去。
   */
  async penalize(scope: string, dimension: string, key: string, windowSeconds: number): Promise<void> {
    if (!key) return;
    await this.redis.incrWindow(`rl:${scope}:${dimension}:${key}`, windowSeconds);
  }
}
