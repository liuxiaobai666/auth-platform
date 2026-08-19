import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface LicenseTokenPayload {
  sub: string;      // license_id
  app: string;      // app_id
  dev: string;      // device_id
  plan: string;     // plan_id
  ver: number;      // 卡密的 tokenVersion，用于批量撤销
  jti: string;      // 令牌唯一 ID，用于精确撤销
  iat: number;
  exp: number;
}

/**
 * 授权令牌的签发与校验，对应 DEVELOPMENT.md 9.1。
 *
 * 撤销有两条通道：
 *   批量撤销 —— 递增卡密的 tokenVersion，该卡密所有已签发令牌立即失效；
 *   精确撤销 —— 把 jti 写入撤销表，只作废某一个令牌。
 * 客户端拿到的令牌只是凭证，真正的授权判断始终在服务端重做一遍。
 */
@Injectable()
export class LicenseTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  private get secret(): string {
    return this.config.get<string>('LICENSE_TOKEN_SECRET')!;
  }

  private get ttlHours(): number {
    const raw = Number(this.config.get('LICENSE_TOKEN_TTL_HOURS') ?? 24);
    // 文档要求默认 24 小时、最长不超过 7 天
    return Math.min(Math.max(raw, 1), 24 * 7);
  }

  async sign(input: {
    licenseId: string; appId: string; deviceId: string; planId: string; tokenVersion: number;
  }): Promise<{ token: string; expiresAt: Date; jti: string }> {
    const jti = this.crypto.genId('jti');
    const expiresIn = this.ttlHours * 3600;
    const token = await this.jwt.signAsync(
      {
        sub: input.licenseId,
        app: input.appId,
        dev: input.deviceId,
        plan: input.planId,
        ver: input.tokenVersion,
        jti,
      },
      { secret: this.secret, expiresIn },
    );
    return { token, expiresAt: new Date(Date.now() + expiresIn * 1000), jti };
  }

  /** 只做密码学校验，不查库。业务状态由调用方另行判断。 */
  async verifySignature(token: string): Promise<LicenseTokenPayload> {
    try {
      return await this.jwt.verifyAsync<LicenseTokenPayload>(token, { secret: this.secret });
    } catch (e) {
      const expired = (e as Error).name === 'TokenExpiredError';
      throw new AppException(expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID);
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    const row = await this.prisma.licenseTokenRevocation.findUnique({ where: { jti } });
    return !!row;
  }

  async revoke(jti: string, licenseId: string, reason: string, expiresAt: Date): Promise<void> {
    await this.prisma.licenseTokenRevocation
      .create({ data: { jti, licenseId, reason, expiresAt } })
      .catch(() => undefined); // 重复撤销视为幂等成功
  }

  /** 清理已自然过期的撤销记录，避免撤销表无限增长。 */
  async purgeExpired(): Promise<number> {
    const res = await this.prisma.licenseTokenRevocation.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return res.count;
  }
}
