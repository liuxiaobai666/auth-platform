import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditModule } from './common/audit/audit.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AdminJwtGuard } from './common/guards/admin-jwt.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { ApiLogMiddleware } from './common/middleware/api-log.middleware';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { PrismaModule } from './common/prisma/prisma.module';
import { RateLimitModule } from './common/ratelimit/rate-limit.module';
import { RedisModule } from './common/redis/redis.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { AuthModule } from './modules/auth/auth.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { BatchesModule } from './modules/batches/batches.module';
import { DocsModule } from './modules/docs/docs.module';
import { LicensesModule } from './modules/licenses/licenses.module';
import { LogsModule } from './modules/logs/logs.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { OpenModule } from './modules/open/open.module';
import { PlansModule } from './modules/plans/plans.module';
import { PluginsModule } from './modules/plugins/plugins.module';
import { ReleasesModule } from './modules/releases/releases.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    PrismaModule,
    RedisModule,
    CryptoModule,
    RateLimitModule,
    AuditModule,
    AuthModule,
    ApplicationsModule,
    PluginsModule,
    PlansModule,
    LicensesModule,
    OpenModule,
    ReleasesModule,
    LogsModule,
    DocsModule,
    MaintenanceModule,
    BatchesModule,
    AnalyticsModule,
    WebhooksModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // 顺序很重要：先认证拿到 admin，再校验权限
    { provide: APP_GUARD, useClass: AdminJwtGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware, ApiLogMiddleware).forRoutes('*');
  }
}
