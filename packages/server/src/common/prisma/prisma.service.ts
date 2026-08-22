import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  async onModuleInit() {
    await this.$connect();
    this.logger.log('数据库已连接');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** 测试用：按外键依赖顺序清空业务表。 */
  async truncateAll() {
    await this.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    const tables = [
      // 子表在前、被引用的表在后（虽然关了外键检查，但保持顺序更清晰）
      'webhook_deliveries', 'webhook_endpoints',
      'license_token_revocations', 'license_key_exports', 'license_activations',
      'license_reservations',
      'license_devices', 'license_keys', 'license_batches', 'plans',
      'app_dist_sites', 'app_releases',
      'application_plugins', 'applications', 'idempotency_records',
      'api_request_logs', 'login_logs', 'audit_logs',
      'admin_user_roles', 'admin_roles', 'admin_users',
    ];
    for (const t of tables) {
      await this.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
    }
    await this.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  }
}
