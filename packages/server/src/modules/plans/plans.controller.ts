import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { CreatePlanDto, ListPlanDto, UpdatePlanDto } from './dto/plan.dto';
import { PlansService } from './plans.service';

@Controller('api/v1/admin/plans')
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLAN_READ)
  list(@Query() query: ListPlanDto) {
    return this.plans.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.PLAN_READ)
  detail(@Param('id') id: string) {
    return this.plans.detail(id);
  }

  @Post()
  @RequirePermissions(Permission.PLAN_WRITE)
  async create(@Body() dto: CreatePlanDto, @Req() req: Request) {
    const plan = await this.plans.create(dto);
    await this.audit.record(req, {
      action: 'plan.create', targetType: 'plan', targetId: plan.id,
      detail: { code: plan.code, name: plan.name, application_id: plan.application_id },
    });
    return plan;
  }

  @Patch(':id')
  @RequirePermissions(Permission.PLAN_WRITE)
  async update(@Param('id') id: string, @Body() dto: UpdatePlanDto, @Req() req: Request) {
    const plan = await this.plans.update(id, dto);
    await this.audit.record(req, {
      action: 'plan.update', targetType: 'plan', targetId: id, detail: { ...dto },
    });
    return plan;
  }

  @Delete(':id')
  @RequirePermissions(Permission.PLAN_WRITE)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const result = await this.plans.remove(id);
    await this.audit.record(req, { action: 'plan.delete', targetType: 'plan', targetId: id });
    return result;
  }
}
