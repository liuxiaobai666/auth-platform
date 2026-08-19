import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { CreatePluginDto, ListPluginDto, RotateSecretDto, UpdatePluginDto } from './dto/plugin.dto';
import { PluginsService } from './plugins.service';

@Controller('api/v1/admin/plugins')
export class PluginsController {
  constructor(
    private readonly plugins: PluginsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLUGIN_READ)
  list(@Query() query: ListPluginDto) {
    return this.plugins.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.PLUGIN_READ)
  detail(@Param('id') id: string) {
    return this.plugins.detail(id);
  }

  @Post()
  @RequirePermissions(Permission.PLUGIN_WRITE)
  async create(@Body() dto: CreatePluginDto, @Req() req: Request) {
    const plugin = await this.plugins.create(dto);
    await this.audit.record(req, {
      action: 'plugin.create', targetType: 'plugin', targetId: plugin.id,
      // 审计明细里绝不能出现 token / secret 原文
      detail: { plugin_id: plugin.plugin_id, application_id: plugin.application_id },
    });
    return plugin;
  }

  @Patch(':id')
  @RequirePermissions(Permission.PLUGIN_WRITE)
  async update(@Param('id') id: string, @Body() dto: UpdatePluginDto, @Req() req: Request) {
    const plugin = await this.plugins.update(id, dto);
    await this.audit.record(req, {
      action: 'plugin.update', targetType: 'plugin', targetId: id,
      detail: { ...dto, config: dto.config ? '[已更新]' : undefined },
    });
    return plugin;
  }

  /** 查看明文凭据：每次调用都留痕。 */
  @Get(':id/credentials')
  @RequirePermissions(Permission.PLUGIN_WRITE)
  async credentials(@Param('id') id: string, @Req() req: Request) {
    const result = await this.plugins.revealCredentials(id);
    await this.audit.record(req, {
      action: 'plugin.reveal_credentials', targetType: 'plugin', targetId: id,
      detail: { plugin_id: result.plugin_id },
    });
    return result;
  }

  @HttpCode(200)
  @Post(':id/rotate-secret')
  @RequirePermissions(Permission.PLUGIN_WRITE)
  async rotateSecret(@Param('id') id: string, @Body() dto: RotateSecretDto, @Req() req: Request) {
    const result = await this.plugins.rotateSecret(id, dto);
    await this.audit.record(req, {
      action: 'plugin.rotate_secret', targetType: 'plugin', targetId: id,
      detail: { grace_minutes: result.grace_minutes },
    });
    return result;
  }

  @HttpCode(200)
  @Post(':id/rotate-token')
  @RequirePermissions(Permission.PLUGIN_WRITE)
  async rotateToken(@Param('id') id: string, @Req() req: Request) {
    const result = await this.plugins.rotateToken(id);
    await this.audit.record(req, {
      action: 'plugin.rotate_token', targetType: 'plugin', targetId: id,
    });
    return result;
  }

  @Delete(':id')
  @RequirePermissions(Permission.PLUGIN_WRITE)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const result = await this.plugins.remove(id);
    await this.audit.record(req, { action: 'plugin.delete', targetType: 'plugin', targetId: id });
    return result;
  }
}
