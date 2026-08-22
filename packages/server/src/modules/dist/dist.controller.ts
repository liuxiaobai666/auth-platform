import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { AdminPrincipal, CurrentAdmin, RequirePermissions } from '../../common/decorators';
import { Permission } from '../../common/auth/permissions';
import { AuditService } from '../../common/audit/audit.service';
import { DistService } from './dist.service';
import { UpdateDistSiteDto } from './dto/dist.dto';

/** 分发页配置。挂在应用下面，一个应用最多一个分发页。 */
@Controller('api/v1/admin/applications')
export class DistController {
  constructor(
    private readonly dist: DistService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/dist-site')
  @RequirePermissions(Permission.APPLICATION_READ)
  get(@Param('id') id: string) {
    return this.dist.getConfig(id);
  }

  @Put(':id/dist-site')
  @RequirePermissions(Permission.APPLICATION_WRITE)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateDistSiteDto,
    @CurrentAdmin() _admin: AdminPrincipal,
    @Req() req: Request,
  ) {
    const site = await this.dist.updateConfig(id, dto);
    await this.audit.record(req, {
      action: 'application.dist_site.update',
      targetType: 'application',
      targetId: id,
      detail: { slug: site.slug, enabled: site.enabled },
    });
    return site;
  }
}
