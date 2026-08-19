import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Request } from 'express';
import { ALL_PERMISSIONS } from '../../common/auth/permissions';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/ratelimit/rate-limit.service';
import { clientIp, userAgent } from '../../common/utils/request.util';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async login(username: string, password: string, req: Request) {
    const ip = clientIp(req);

    // 先按 IP 与用户名两个维度限流，避免撞库把账号锁定策略当成拒绝服务手段
    await this.rateLimit.consume('login', [
      { dimension: 'ip', key: ip, limit: 20, windowSeconds: 300 },
      { dimension: 'username', key: username.toLowerCase(), limit: 10, windowSeconds: 300 },
    ]);

    const user = await this.prisma.adminUser.findUnique({
      where: { username },
      include: { roles: { include: { role: true } } },
    });

    const fail = async (reason: string, code: string, message?: string): Promise<never> => {
      await this.writeLoginLog(req, username, user?.id ?? null, false, reason);
      throw new AppException(code, message);
    };

    if (!user) {
      // 用户不存在时也走一次 argon2 校验，抹平时间差，避免枚举用户名
      await argon2.verify(
        '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8',
        password,
      ).catch(() => false);
      return fail('user_not_found', ErrorCode.BAD_CREDENTIALS);
    }

    if (user.status !== 'active') {
      return fail('disabled', ErrorCode.ACCOUNT_DISABLED);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      return fail(
        'locked',
        ErrorCode.ACCOUNT_LOCKED,
        `账号已锁定，请在 ${Math.ceil(seconds / 60)} 分钟后重试`,
      );
    }

    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      const maxFailed = Number(this.config.get('LOGIN_MAX_FAILED') ?? 5);
      const lockMinutes = Number(this.config.get('LOGIN_LOCK_MINUTES') ?? 15);
      const failedCount = user.failedCount + 1;
      const shouldLock = failedCount >= maxFailed;
      await this.prisma.adminUser.update({
        where: { id: user.id },
        data: {
          failedCount: shouldLock ? 0 : failedCount,
          lockedUntil: shouldLock ? new Date(Date.now() + lockMinutes * 60_000) : null,
        },
      });
      if (shouldLock) {
        return fail(
          'locked',
          ErrorCode.ACCOUNT_LOCKED,
          `连续 ${maxFailed} 次密码错误，账号已锁定 ${lockMinutes} 分钟`,
        );
      }
      return fail('bad_password', ErrorCode.BAD_CREDENTIALS);
    }

    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { failedCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip },
    });
    await this.writeLoginLog(req, username, user.id, true, null);
    await this.rateLimit.reset('login', 'username', username.toLowerCase());

    return this.issueTokens(user.id, user.username, user.tokenVersion, user);
  }

  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch (e) {
      const expired = (e as Error).name === 'TokenExpiredError';
      throw new AppException(
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        expired ? '登录已过期，请重新登录' : '刷新令牌无效',
      );
    }
    if (payload.typ !== 'refresh') {
      throw new AppException(ErrorCode.TOKEN_INVALID, '令牌类型不正确');
    }

    const user = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      include: { roles: { include: { role: true } } },
    });
    if (!user || user.status !== 'active') {
      throw new AppException(ErrorCode.TOKEN_INVALID, '账号不可用');
    }
    if (user.tokenVersion !== payload.ver) {
      throw new AppException(ErrorCode.TOKEN_INVALID, '登录状态已失效，请重新登录');
    }

    return this.issueTokens(user.id, user.username, user.tokenVersion, user);
  }

  /** 退出登录：递增 tokenVersion，让该账号已签发的所有令牌立即失效。 */
  async logout(adminId: string) {
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { tokenVersion: { increment: 1 } },
    });
    return { success: true };
  }

  async changePassword(adminId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!user) throw AppException.notFound('账号不存在');

    const ok = await argon2.verify(user.passwordHash, oldPassword).catch(() => false);
    if (!ok) throw new AppException(ErrorCode.BAD_CREDENTIALS, '原密码不正确');
    if (oldPassword === newPassword) {
      throw AppException.invalid('新密码不能与原密码相同');
    }

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        passwordHash: await AuthService.hashPassword(newPassword),
        // 改密后强制所有端重新登录
        tokenVersion: { increment: 1 },
      },
    });
    return { success: true };
  }

  async profile(adminId: string) {
    const user = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw AppException.notFound('账号不存在');
    return {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      email: user.email,
      is_super_admin: user.isSuperAdmin,
      roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name })),
      permissions: this.resolvePermissions(user),
      last_login_at: user.lastLoginAt,
      last_login_ip: user.lastLoginIp,
    };
  }

  static hashPassword(plain: string): Promise<string> {
    // OWASP 推荐参数：19MiB 内存、2 次迭代、并行度 1
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  private resolvePermissions(user: any): string[] {
    if (user.isSuperAdmin) return [...ALL_PERMISSIONS];
    return Array.from(
      new Set((user.roles ?? []).flatMap((r: any) => (r.role.permissions as string[]) ?? [])),
    );
  }

  private async issueTokens(id: string, username: string, ver: number, user: any) {
    // @nestjs/jwt 的 expiresIn 类型是 ms 的字面量联合类型，配置来源是运行期字符串，
    // 这里显式放宽，校验交给启动时的配置检查
    const accessTtl = (this.config.get<string>('JWT_ACCESS_TTL') ?? '2h') as any;
    const refreshTtl = (this.config.get<string>('JWT_REFRESH_TTL') ?? '7d') as any;

    const [access, refresh] = await Promise.all([
      this.jwt.signAsync(
        { sub: id, username, ver, typ: 'access' },
        { secret: this.config.get<string>('JWT_ACCESS_SECRET'), expiresIn: accessTtl },
      ),
      this.jwt.signAsync(
        { sub: id, ver, typ: 'refresh' },
        { secret: this.config.get<string>('JWT_REFRESH_SECRET'), expiresIn: refreshTtl },
      ),
    ]);

    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: accessTtl,
      admin: {
        id,
        username,
        nickname: user.nickname,
        is_super_admin: user.isSuperAdmin,
        permissions: this.resolvePermissions(user),
      },
    };
  }

  private async writeLoginLog(
    req: Request,
    username: string,
    adminUserId: string | null,
    success: boolean,
    failReason: string | null,
  ) {
    await this.prisma.loginLog
      .create({
        data: {
          id: this.crypto.genId('lgl'),
          username: username.slice(0, 64),
          adminUserId,
          success,
          failReason,
          ip: clientIp(req),
          userAgent: userAgent(req),
        },
      })
      .catch(() => undefined);
  }
}
