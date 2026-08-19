import { Controller, Get, Query } from '@nestjs/common';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { AnalyticsService } from './analytics.service';

@Controller('api/v1/admin/analytics')
@RequirePermissions(Permission.LICENSE_READ)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@Query('application_id') applicationId?: string) {
    return this.analytics.overview(applicationId);
  }

  @Get('trend')
  trend(@Query('days') days?: string, @Query('application_id') applicationId?: string) {
    return this.analytics.trend(Number(days) || 30, applicationId);
  }

  @Get('by-application')
  byApplication() {
    return this.analytics.byApplication();
  }
}
