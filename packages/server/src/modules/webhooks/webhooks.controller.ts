import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { CreateEndpointDto, UpdateEndpointDto } from './dto/webhook.dto';
import { EndpointsService } from './endpoints.service';
import { WebhooksService } from './webhooks.service';

/** Webhook 归入应用配置范畴，用 application:write 权限。 */
@Controller('api/v1/admin/webhooks')
export class WebhooksController {
  constructor(
    private readonly endpoints: EndpointsService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
  ) {}

  @Get('events')
  @RequirePermissions(Permission.APPLICATION_READ)
  events() {
    return WebhooksService.allEvents();
  }

  @Get()
  @RequirePermissions(Permission.APPLICATION_READ)
  list(@Query('application_id') applicationId?: string) {
    return this.endpoints.list(applicationId);
  }

  @Get('deliveries')
  @RequirePermissions(Permission.APPLICATION_READ)
  deliveries(
    @Query('endpoint_id') endpointId?: string,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
  ) {
    return this.endpoints.deliveries({ endpoint_id: endpointId, status, page, page_size: pageSize });
  }

  @Post()
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async create(@Body() dto: CreateEndpointDto, @Req() req: Request) {
    const ep = await this.endpoints.create(dto);
    await this.audit.record(req, {
      action: 'webhook.create', targetType: 'webhook', targetId: ep.id,
      detail: { app_id: ep.app_id, url: ep.url, events: ep.events },
    });
    return ep;
  }

  @Patch(':id')
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async update(@Param('id') id: string, @Body() dto: UpdateEndpointDto, @Req() req: Request) {
    const ep = await this.endpoints.update(id, dto);
    await this.audit.record(req, {
      action: 'webhook.update', targetType: 'webhook', targetId: id, detail: { ...dto },
    });
    return ep;
  }

  @Get(':id/secret')
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async secret(@Param('id') id: string, @Req() req: Request) {
    const result = await this.endpoints.revealSecret(id);
    await this.audit.record(req, { action: 'webhook.reveal_secret', targetType: 'webhook', targetId: id });
    return result;
  }

  @Delete(':id')
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const result = await this.endpoints.remove(id);
    await this.audit.record(req, { action: 'webhook.delete', targetType: 'webhook', targetId: id });
    return result;
  }

  /** 手动重投一条失败/死信记录。 */
  @HttpCode(200)
  @Post('deliveries/:id/redeliver')
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async redeliver(@Param('id') id: string, @Req() req: Request) {
    await this.webhooks.redeliver(id);
    await this.audit.record(req, { action: 'webhook.redeliver', targetType: 'webhook_delivery', targetId: id });
    return { success: true };
  }
}
