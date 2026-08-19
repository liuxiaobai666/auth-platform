import { Controller, Get, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Permission } from '../../common/auth/permissions';
import { RequirePermissions } from '../../common/decorators';
import { maskDeviceId } from '../../common/utils/mask.util';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizePaging } from '../../common/utils/request.util';

/** 日志查询。四类日志分别对应文档第 11 章的四张表。 */
@Controller('api/v1/admin/logs')
@RequirePermissions(Permission.AUDIT_READ)
export class LogsController {
  constructor(private readonly prisma: PrismaService) {}

  /** 管理员操作日志 */
  @Get('audit')
  async audit(
    @Query('action') action?: string,
    @Query('username') username?: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
  ) {
    const p = normalizePaging(page, pageSize);
    const where: Prisma.AuditLogWhereInput = {
      ...(action ? { action: { contains: action } } : {}),
      ...(username ? { username: { contains: username } } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      total, page: p.page, page_size: p.pageSize,
      items: items.map((l) => ({
        id: l.id, username: l.username, action: l.action,
        target_type: l.targetType, target_id: l.targetId,
        detail: l.detail, ip: l.ip, created_at: l.createdAt,
      })),
    };
  }

  /** 登录日志，含失败原因，用于排查撞库和账号锁定 */
  @Get('login')
  async login(
    @Query('username') username?: string,
    @Query('success') success?: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
  ) {
    const p = normalizePaging(page, pageSize);
    const where: Prisma.LoginLogWhereInput = {
      ...(username ? { username: { contains: username } } : {}),
      ...(success !== undefined && success !== '' ? { success: success === 'true' } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.loginLog.count({ where }),
      this.prisma.loginLog.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      total, page: p.page, page_size: p.pageSize,
      items: items.map((l) => ({
        id: l.id, username: l.username, success: l.success,
        fail_reason: l.failReason, ip: l.ip, created_at: l.createdAt,
      })),
    };
  }

  /** API 请求日志 */
  @Get('api')
  async api(
    @Query('plugin_id') pluginId?: string,
    @Query('code') code?: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
  ) {
    const p = normalizePaging(page, pageSize);
    const where: Prisma.ApiRequestLogWhereInput = {
      ...(pluginId ? { pluginId } : {}),
      ...(code ? { code } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.apiRequestLog.count({ where }),
      this.prisma.apiRequestLog.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      total, page: p.page, page_size: p.pageSize,
      items: items.map((l) => ({
        id: l.id, request_id: l.requestId, method: l.method, path: l.path,
        plugin_id: l.pluginId, status_code: l.statusCode, code: l.code,
        duration_ms: l.durationMs, ip: l.ip, created_at: l.createdAt,
      })),
    };
  }

  /** 授权日志：激活、验证、解绑的全量流水 */
  @Get('activations')
  async activations(
    @Query('application_id') applicationId?: string,
    @Query('action') action?: string,
    @Query('success') success?: string,
    @Query('code') code?: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
  ) {
    const p = normalizePaging(page, pageSize);
    const where: Prisma.LicenseActivationWhereInput = {
      ...(applicationId ? { applicationId } : {}),
      ...(action ? { action: action as any } : {}),
      ...(success !== undefined && success !== '' ? { success: success === 'true' } : {}),
      ...(code ? { code } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.licenseActivation.count({ where }),
      this.prisma.licenseActivation.findMany({
        where, skip: p.skip, take: p.take, orderBy: { createdAt: 'desc' },
        include: { application: { select: { appId: true } } },
      }),
    ]);
    return {
      total, page: p.page, page_size: p.pageSize,
      items: items.map((l) => ({
        id: l.id, license_id: l.licenseId, app_id: l.application?.appId,
        plugin_id: l.pluginId,
        // 设备指纹脱敏后再返回，日志页没有看完整指纹的必要
        device_id: maskDeviceId(l.deviceId),
        action: l.action, success: l.success, code: l.code,
        client_version: l.clientVersion, ip: l.ip,
        request_id: l.requestId, created_at: l.createdAt,
      })),
    };
  }
}
