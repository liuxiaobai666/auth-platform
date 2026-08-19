import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from '../../common/audit/audit.service';
import { AdminPrincipal, CurrentAdmin, Public } from '../../common/decorators';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto } from './dto/auth.dto';

@Controller('api/v1/admin/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const result = await this.auth.login(dto.username, dto.password, req);
    (req as any).admin = { id: result.admin.id, username: result.admin.username };
    await this.audit.record(req, { action: 'admin.login', targetType: 'admin_user', targetId: result.admin.id });
    return result;
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  @HttpCode(200)
  @Post('logout')
  async logout(@CurrentAdmin() admin: AdminPrincipal, @Req() req: Request) {
    const result = await this.auth.logout(admin.id);
    await this.audit.record(req, { action: 'admin.logout', targetType: 'admin_user', targetId: admin.id });
    return result;
  }

  @Get('profile')
  profile(@CurrentAdmin() admin: AdminPrincipal) {
    return this.auth.profile(admin.id);
  }

  @HttpCode(200)
  @Post('change-password')
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentAdmin() admin: AdminPrincipal,
    @Req() req: Request,
  ) {
    const result = await this.auth.changePassword(admin.id, dto.old_password, dto.new_password);
    await this.audit.record(req, {
      action: 'admin.change_password',
      targetType: 'admin_user',
      targetId: admin.id,
    });
    return result;
  }
}
