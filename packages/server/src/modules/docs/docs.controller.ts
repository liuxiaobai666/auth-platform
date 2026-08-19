import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { DocsService } from './docs.service';
import { InvokeDto } from './dto/playground.dto';

@Controller('api/v1/admin/docs')
export class DocsController {
  constructor(
    private readonly docs: DocsService,
    private readonly audit: AuditService,
  ) {}

  /** 填充示例代码所需的上下文。只读，application:read 即可。 */
  @Get('context')
  @RequirePermissions(Permission.APPLICATION_READ)
  context(@Query('application_id') applicationId?: string) {
    return this.docs.context(applicationId);
  }

  /** 完整接入指南 markdown 原文。 */
  @Get('markdown')
  @RequirePermissions(Permission.APPLICATION_READ)
  markdown() {
    return this.docs.markdown();
  }

  /** 在线测试可选的接口清单。 */
  @Get('routes')
  @RequirePermissions(Permission.APPLICATION_READ)
  routes() {
    return this.docs.routes();
  }

  /**
   * 在线测试：代理调用开放 API。
   *
   * 需要 plugin:write ——因为它等价于用应用密钥发起真实授权请求，能拿到这个权限的人
   * 本来就能通过「查看凭据」看到 secret。并且每次调用都写审计日志。
   */
  @HttpCode(200)
  @Post('playground/invoke')
  @RequirePermissions(Permission.PLUGIN_WRITE)
  async invoke(@Body() dto: InvokeDto, @Req() req: Request) {
    const result = await this.docs.invoke({
      pluginId: dto.plugin_id,
      action: dto.action as any,
      body: dto.body,
      query: dto.query,
    });
    await this.audit.record(req, {
      action: 'docs.playground_invoke',
      targetType: 'plugin',
      targetId: dto.plugin_id,
      // 只记动作和结果状态，不记完整请求体（可能含卡密），也不记签名
      detail: {
        plugin_id: dto.plugin_id,
        route: dto.action,
        response_status: result.response.status,
      },
    });
    return result;
  }
}
