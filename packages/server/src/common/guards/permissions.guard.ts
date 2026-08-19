import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminPrincipal, PERMISSIONS_KEY } from '../decorators';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const admin: AdminPrincipal | undefined = context.switchToHttp().getRequest().admin;
    if (!admin) throw new AppException(ErrorCode.UNAUTHORIZED);
    if (admin.isSuperAdmin) return true;

    const missing = required.filter((p) => !admin.permissions.includes(p));
    if (missing.length) {
      throw new AppException(
        ErrorCode.PERMISSION_DENIED,
        `权限不足，缺少：${missing.join('、')}`,
      );
    }
    return true;
  }
}
