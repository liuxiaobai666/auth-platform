import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { AdminPrincipal, CurrentAdmin, RequirePermissions } from '../../common/decorators';
import { ApplicationsService } from './applications.service';
import {
  CreateApplicationDto, ListApplicationDto, UpdateApplicationDto, UpdatePolicyDto,
} from './dto/application.dto';

@Controller('api/v1/admin/applications')
export class ApplicationsController {
  constructor(
    private readonly apps: ApplicationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.APPLICATION_READ)
  list(@Query() query: ListApplicationDto) {
    return this.apps.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.APPLICATION_READ)
  detail(@Param('id') id: string) {
    return this.apps.detail(id);
  }

  @Post()
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async create(
    @Body() dto: CreateApplicationDto,
    @CurrentAdmin() admin: AdminPrincipal,
    @Req() req: Request,
  ) {
    // 顺带建默认凭据属于插件管理动作，没有 plugin:write 就只建应用，
    // 不能借着「应用创建」这个入口绕过权限体系发钥匙
    const canManagePlugin = admin.isSuperAdmin || admin.permissions.includes(Permission.PLUGIN_WRITE);
    const withDefaultPlugin = (dto.with_default_plugin ?? true) && canManagePlugin;

    const app = await this.apps.create(dto, { withDefaultPlugin });
    await this.audit.record(req, {
      action: 'application.create',
      targetType: 'application',
      targetId: app.id,
      detail: { app_id: app.app_id, name: app.name, with_default_plugin: withDefaultPlugin },
    });
    if (withDefaultPlugin && app.default_plugin) {
      await this.audit.record(req, {
        action: 'plugin.create',
        targetType: 'plugin',
        targetId: (app.default_plugin as any).id,
        detail: { plugin_id: (app.default_plugin as any).plugin_id, source: 'application.create' },
      });
    }
    return app;
  }

  @Patch(':id')
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async update(@Param('id') id: string, @Body() dto: UpdateApplicationDto, @Req() req: Request) {
    const app = await this.apps.update(id, dto);
    await this.audit.record(req, {
      action: 'application.update',
      targetType: 'application',
      targetId: id,
      detail: { ...dto },
    });
    return app;
  }

  /** 远程管控：熔断、维护、版本策略、公告。与普通编辑分开授权。 */
  @Patch(':id/policy')
  @RequirePermissions(Permission.APPLICATION_CONTROL)
  async updatePolicy(@Param('id') id: string, @Body() dto: UpdatePolicyDto, @Req() req: Request) {
    const app = await this.apps.updatePolicy(id, dto);
    await this.audit.record(req, {
      action: 'application.policy_update',
      targetType: 'application',
      targetId: id,
      detail: { ...dto },
    });
    return app;
  }

  @Delete(':id')
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const detail = await this.apps.detail(id);
    const result = await this.apps.remove(id);
    await this.audit.record(req, {
      action: 'application.delete',
      targetType: 'application',
      targetId: id,
      detail: { app_id: detail.app_id, name: detail.name },
    });
    return result;
  }
}
