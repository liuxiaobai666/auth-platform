import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface CleanupResult {
  idempotency_records: number;
  token_revocations: number;
  api_request_logs: number;
  login_logs: number;
  license_activations: number;
}

/**
 * 数据卫生：几张只增不减的表会随时间无限膨胀，拖慢查询。
 *
 * - idempotency_records / license_token_revocations：过了各自的 expiresAt 就没用了，直接删。
 * - api_request_logs / login_logs / license_activations：按可配置的保留天数滚动删除，
 *   超过保留期的历史日志清掉。默认 90 天，够排障与审计追溯，也不会让表无限长。
 *
 * 每天凌晨 3 点跑一次（低峰），也可由管理员手动触发。
 *
 * 时区注意：expiresAt / createdAt 的读写全部经 Prisma 用 JS Date（UTC），两边同源，
 * 比较正确。若有人绕过应用、直接用 SQL 的 NOW() 操作这些表，需注意 MySQL 会话时区
 * 与应用 UTC 的差异，否则可能删错行。
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get logRetentionDays(): number {
    const raw = Number(this.config.get('LOG_RETENTION_DAYS') ?? 90);
    return Number.isFinite(raw) && raw > 0 ? raw : 90;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'daily-cleanup' })
  async scheduledCleanup(): Promise<void> {
    const result = await this.runCleanup();
    this.logger.log(
      `定时清理完成：幂等 ${result.idempotency_records}、撤销令牌 ${result.token_revocations}、` +
        `API日志 ${result.api_request_logs}、登录日志 ${result.login_logs}、授权日志 ${result.license_activations}`,
    );
  }

  /** 执行清理，返回各表删除的行数。手动触发也走这里。 */
  async runCleanup(): Promise<CleanupResult> {
    const now = new Date();
    const logCutoff = new Date(now.getTime() - this.logRetentionDays * 86400_000);

    // 过期的易失记录：直接按 expiresAt 删
    const [idem, revoked] = await Promise.all([
      this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.prisma.licenseTokenRevocation.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);

    // 历史日志：按保留期滚动删除
    const [apiLog, loginLog, actLog] = await Promise.all([
      this.prisma.apiRequestLog.deleteMany({ where: { createdAt: { lt: logCutoff } } }),
      this.prisma.loginLog.deleteMany({ where: { createdAt: { lt: logCutoff } } }),
      this.prisma.licenseActivation.deleteMany({ where: { createdAt: { lt: logCutoff } } }),
    ]);

    return {
      idempotency_records: idem.count,
      token_revocations: revoked.count,
      api_request_logs: apiLog.count,
      login_logs: loginLog.count,
      license_activations: actLog.count,
    };
  }

  /** 各表当前行数与保留策略，给后台展示。 */
  async stats() {
    const now = new Date();
    const logCutoff = new Date(now.getTime() - this.logRetentionDays * 86400_000);
    const [idem, idemExpired, revoked, revokedExpired, apiLog, apiOld, loginLog, actLog] =
      await Promise.all([
        this.prisma.idempotencyRecord.count(),
        this.prisma.idempotencyRecord.count({ where: { expiresAt: { lt: now } } }),
        this.prisma.licenseTokenRevocation.count(),
        this.prisma.licenseTokenRevocation.count({ where: { expiresAt: { lt: now } } }),
        this.prisma.apiRequestLog.count(),
        this.prisma.apiRequestLog.count({ where: { createdAt: { lt: logCutoff } } }),
        this.prisma.loginLog.count(),
        this.prisma.licenseActivation.count(),
      ]);
    return {
      log_retention_days: this.logRetentionDays,
      tables: [
        { name: 'idempotency_records', total: idem, cleanable: idemExpired, rule: '过期即删' },
        { name: 'license_token_revocations', total: revoked, cleanable: revokedExpired, rule: '过期即删' },
        { name: 'api_request_logs', total: apiLog, cleanable: apiOld, rule: `保留 ${this.logRetentionDays} 天` },
        { name: 'login_logs', total: loginLog, cleanable: null, rule: `保留 ${this.logRetentionDays} 天` },
        { name: 'license_activations', total: actLog, cleanable: null, rule: `保留 ${this.logRetentionDays} 天` },
      ],
    };
  }
}
