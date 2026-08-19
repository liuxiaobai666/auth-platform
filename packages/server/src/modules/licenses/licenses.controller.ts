import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { AdminPrincipal, CurrentAdmin, RequirePermissions } from '../../common/decorators';
import { clientIp } from '../../common/utils/request.util';
import {
  BatchReasonDto, ExportLicenseDto, GenerateLicenseDto, ListLicenseDto, ReasonDto,
  RenewLicenseDto, UnbindDeviceDto,
} from './dto/license.dto';
import { LicensesService } from './licenses.service';

@Controller('api/v1/admin/licenses')
export class LicensesController {
  constructor(
    private readonly licenses: LicensesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.LICENSE_READ)
  list(@Query() query: ListLicenseDto) {
    return this.licenses.list(query);
  }

  @Get('stats')
  @RequirePermissions(Permission.LICENSE_READ)
  stats(@Query('application_id') applicationId?: string) {
    return this.licenses.stats(applicationId);
  }

  @Get(':id')
  @RequirePermissions(Permission.LICENSE_READ)
  detail(@Param('id') id: string) {
    return this.licenses.detail(id);
  }

  @HttpCode(200)
  @Post('generate')
  @RequirePermissions(Permission.LICENSE_WRITE)
  async generate(
    @Body() dto: GenerateLicenseDto,
    @CurrentAdmin() admin: AdminPrincipal,
    @Req() req: Request,
  ) {
    const result = await this.licenses.generate(dto, admin.id);
    await this.audit.record(req, {
      action: 'license.generate', targetType: 'license_batch', targetId: result.batch_id,
      // 只记录数量与套餐，绝不记录任何卡密内容
      detail: { count: result.count, plan_id: dto.plan_id, app_id: result.app_id, prefix: dto.prefix },
    });
    return result;
  }

  /** 导出明文卡密：全系统唯一的解密出口。 */
  @HttpCode(200)
  @Post('export')
  @RequirePermissions(Permission.LICENSE_EXPORT)
  async export(
    @Body() dto: ExportLicenseDto,
    @CurrentAdmin() admin: AdminPrincipal,
    @Req() req: Request,
  ) {
    const result = await this.licenses.exportPlain(dto, admin.id, clientIp(req));
    await this.audit.record(req, {
      action: 'license.export', targetType: 'license_batch', targetId: dto.batch_id,
      detail: { count: result.count, filter: { ...dto } },
    });
    return result;
  }

  @HttpCode(200)
  @Post(':id/ban')
  @RequirePermissions(Permission.LICENSE_BAN)
  async ban(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    const result = await this.licenses.ban([id], dto.reason);
    await this.audit.record(req, {
      action: 'license.ban', targetType: 'license', targetId: id, detail: { reason: dto.reason },
    });
    return result;
  }

  @HttpCode(200)
  @Post('batch/ban')
  @RequirePermissions(Permission.LICENSE_BAN)
  async batchBan(@Body() dto: BatchReasonDto, @Req() req: Request) {
    const result = await this.licenses.ban(dto.ids, dto.reason);
    await this.audit.record(req, {
      action: 'license.batch_ban', targetType: 'license',
      detail: { count: dto.ids.length, affected: result.affected, reason: dto.reason },
    });
    return result;
  }

  @HttpCode(200)
  @Post(':id/unban')
  @RequirePermissions(Permission.LICENSE_BAN)
  async unban(@Param('id') id: string, @Req() req: Request) {
    const result = await this.licenses.unban([id]);
    await this.audit.record(req, { action: 'license.unban', targetType: 'license', targetId: id });
    return result;
  }

  @HttpCode(200)
  @Post(':id/revoke')
  @RequirePermissions(Permission.LICENSE_BAN)
  async revoke(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    const result = await this.licenses.revoke([id], dto.reason);
    await this.audit.record(req, {
      action: 'license.revoke', targetType: 'license', targetId: id, detail: { reason: dto.reason },
    });
    return result;
  }

  @HttpCode(200)
  @Post(':id/renew')
  @RequirePermissions(Permission.LICENSE_WRITE)
  async renew(@Param('id') id: string, @Body() dto: RenewLicenseDto, @Req() req: Request) {
    const result = await this.licenses.renew(id, dto);
    await this.audit.record(req, {
      action: 'license.renew', targetType: 'license', targetId: id,
      detail: { days: dto.days, reason: dto.reason, expires_at: result.expires_at },
    });
    return result;
  }

  @Get(':id/devices')
  @RequirePermissions(Permission.LICENSE_READ)
  devices(@Param('id') id: string) {
    return this.licenses.devices(id);
  }

  @HttpCode(200)
  @Post(':id/devices/:deviceRowId/unbind')
  @RequirePermissions(Permission.LICENSE_UNBIND)
  async unbind(
    @Param('id') id: string,
    @Param('deviceRowId') deviceRowId: string,
    @Body() dto: UnbindDeviceDto,
    @CurrentAdmin() admin: AdminPrincipal,
    @Req() req: Request,
  ) {
    const result = await this.licenses.unbindDevice(id, deviceRowId, dto, `admin:${admin.username}`);
    await this.audit.record(req, {
      action: 'license.unbind_device', targetType: 'license', targetId: id,
      detail: { device_row_id: deviceRowId, reason: dto.reason, count_as_rebind: !!dto.count_as_rebind },
    });
    return result;
  }
}
