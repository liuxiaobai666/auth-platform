import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AdminPrincipal, PUBLIC_KEY } from '../decorators';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSIONS } from '../auth/permissions';

/**
 * 管理员访问令牌校验。
 * 权限每次从数据库实时读取，保证角色调整后立刻生效，不用等令牌过期。
 */
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      throw new AppException(ErrorCode.UNAUTHORIZED, '缺少访问令牌');
    }

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(header.slice(7), {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch (e) {
      const expired = (e as Error).name === 'TokenExpiredError';
      throw new AppException(
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        expired ? '访问令牌已过期' : '访问令牌无效',
      );
    }

    if (payload.typ !== 'access') {
      throw new AppException(ErrorCode.TOKEN_INVALID, '令牌类型不正确');
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      include: { roles: { include: { role: true } } },
    });
    if (!admin) throw new AppException(ErrorCode.TOKEN_INVALID, '账号不存在');
    if (admin.status !== 'active') throw new AppException(ErrorCode.ACCOUNT_DISABLED);
    // 改密码、停用、手动踢下线都会递增 tokenVersion，使旧令牌立即失效
    if (admin.tokenVersion !== payload.ver) {
      throw new AppException(ErrorCode.TOKEN_INVALID, '登录状态已失效，请重新登录');
    }

    const permissions = admin.isSuperAdmin
      ? [...ALL_PERMISSIONS]
      : Array.from(
          new Set(admin.roles.flatMap((r) => (r.role.permissions as string[]) ?? [])),
        );

    (req as any).admin = {
      id: admin.id,
      username: admin.username,
      isSuperAdmin: admin.isSuperAdmin,
      permissions,
    } satisfies AdminPrincipal;

    return true;
  }
}
