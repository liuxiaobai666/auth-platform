import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { BatchesService } from './batches.service';
import { ListBatchDto, RevokeBatchDto, UpdateBatchDto } from './dto/batch.dto';

@Controller('api/v1/admin/batches')
export class BatchesController {
  constructor(
    private readonly batches: BatchesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.LICENSE_READ)
  list(@Query() query: ListBatchDto) {
    return this.batches.list(query);
  }

  @Get('channels')
  @RequirePermissions(Permission.LICENSE_READ)
  channels() {
    return this.batches.channels();
  }

  @Get(':id')
  @RequirePermissions(Permission.LICENSE_READ)
  detail(@Param('id') id: string) {
    return this.batches.detail(id);
  }

  /** 改渠道标记/备注。 */
  @Patch(':id')
  @RequirePermissions(Permission.LICENSE_WRITE)
  async update(@Param('id') id: string, @Body() dto: UpdateBatchDto, @Req() req: Request) {
    const result = await this.batches.update(id, dto);
    await this.audit.record(req, {
      action: 'batch.update', targetType: 'license_batch', targetId: id, detail: { ...dto },
    });
    return result;
  }

  /** 整批作废。高危，要 license:ban 权限并留痕。 */
  @HttpCode(200)
  @Post(':id/revoke-all')
  @RequirePermissions(Permission.LICENSE_BAN)
  async revokeAll(@Param('id') id: string, @Body() dto: RevokeBatchDto, @Req() req: Request) {
    const result = await this.batches.revokeAll(id, dto.reason);
    await this.audit.record(req, {
      action: 'batch.revoke_all', targetType: 'license_batch', targetId: id,
      detail: { reason: dto.reason, affected: result.affected },
    });
    return result;
  }
}
