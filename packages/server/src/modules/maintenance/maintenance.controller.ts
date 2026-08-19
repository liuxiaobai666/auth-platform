import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { MaintenanceService } from './maintenance.service';

@Controller('api/v1/admin/maintenance')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
  ) {}

  /** 各表体量与保留策略。用 audit:read 即可看。 */
  @Get('stats')
  @RequirePermissions(Permission.AUDIT_READ)
  stats() {
    return this.maintenance.stats();
  }

  /** 手动触发清理。高危批量删除，要 admin:write 并留痕。 */
  @HttpCode(200)
  @Post('cleanup')
  @RequirePermissions(Permission.ADMIN_WRITE)
  async cleanup(@Req() req: Request) {
    const result = await this.maintenance.runCleanup();
    await this.audit.record(req, {
      action: 'maintenance.cleanup',
      targetType: 'system',
      detail: { ...result },
    });
    return result;
  }
}
