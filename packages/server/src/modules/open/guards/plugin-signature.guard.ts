import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PluginPrincipal } from '../../../common/decorators';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';

/**
 * 插件侧接口的认证守卫，实现 DEVELOPMENT.md 8.7。
 *
 * 两套凭据各司其职：
 *   Bearer Token 用于识别调用方（路由、限流、日志归属）；
 *   HMAC 签名用于证明请求确实由持有密钥的插件发出且未被篡改。
 * 只有 Token 而签名错误一律拒绝。
 *
 * 校验顺序上有意把签名放在 nonce 之前：先验签能让未持有密钥的请求
 * 完全不接触 Redis，既避免被人刷爆 nonce 空间，也避免合法客户端
 * 在签名失败重试时被自己刚写入的 nonce 挡住。
 */
@Injectable()
export class PluginSignatureGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) {
      throw new AppException(ErrorCode.UNAUTHORIZED, '缺少插件 Token');
    }
    const token = auth.slice(7).trim();

    const pluginId = String(req.headers['x-plugin-id'] ?? '');
    const timestamp = String(req.headers['x-timestamp'] ?? '');
    const nonce = String(req.headers['x-nonce'] ?? '');
    const signature = String(req.headers['x-signature'] ?? '');

    if (!pluginId || !timestamp || !nonce || !signature) {
      throw new AppException(
        ErrorCode.SIGNATURE_INVALID,
        '缺少签名请求头，需要 X-Plugin-Id、X-Timestamp、X-Nonce 和 X-Signature',
      );
    }
    if (nonce.length < 8 || nonce.length > 128) {
      throw new AppException(ErrorCode.SIGNATURE_INVALID, 'X-Nonce 长度需在 8 到 128 之间');
    }

    // 1. 插件存在、状态可用、Token 匹配
    const plugin = await this.prisma.applicationPlugin.findUnique({
      where: { pluginId },
      include: { application: { select: { id: true, appId: true } } },
    });
    if (!plugin) throw new AppException(ErrorCode.PLUGIN_DISABLED, '插件不存在');
    if (plugin.status === 'draft' || plugin.status === 'disabled') {
      throw new AppException(ErrorCode.PLUGIN_DISABLED, `插件当前状态为 ${plugin.status}，不可调用`);
    }
    if (!this.crypto.safeEqual(this.crypto.sha256(token), plugin.tokenHash)) {
      // 不区分「Token 错」和「签名错」，避免把线索泄露给攻击方
      throw new AppException(ErrorCode.SIGNATURE_INVALID);
    }

    // 2. 时间戳窗口
    const windowSeconds = Number(this.config.get('SIGNATURE_WINDOW_SECONDS') ?? 300);
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      throw new AppException(ErrorCode.SIGNATURE_INVALID, 'X-Timestamp 不是合法的 Unix 秒');
    }
    const drift = Math.abs(Date.now() / 1000 - ts);
    if (drift > windowSeconds) {
      throw new AppException(
        ErrorCode.TIMESTAMP_EXPIRED,
        `请求时间与服务端相差 ${Math.round(drift)} 秒，超出 ${windowSeconds} 秒窗口，请校准系统时间`,
      );
    }

    // 3. 验签（当前密钥，失败再试轮换期内的旧密钥）
    const bodyHash = this.crypto.sha256((req as any).rawBody ?? Buffer.alloc(0));
    const payload = [req.method.toUpperCase(), req.originalUrl, timestamp, nonce, bodyHash].join('\n');

    const secrets: string[] = [this.crypto.decrypt(plugin.secretCipher)];
    if (plugin.prevSecretCipher && plugin.prevSecretExpiresAt && plugin.prevSecretExpiresAt > new Date()) {
      secrets.push(this.crypto.decrypt(plugin.prevSecretCipher));
    }
    const matched = secrets.some((s) => this.crypto.safeEqual(this.crypto.hmacSha256(s, payload), signature));
    if (!matched) throw new AppException(ErrorCode.SIGNATURE_INVALID);

    // 4. nonce 防重放：签名通过后才占用，TTL 与时间窗一致
    const fresh = await this.redis.setNx(`nonce:${pluginId}:${nonce}`, windowSeconds);
    if (!fresh) {
      throw new AppException(ErrorCode.NONCE_REPLAYED);
    }

    (req as any).plugin = {
      id: plugin.id,
      pluginId: plugin.pluginId,
      applicationId: plugin.applicationId,
      appId: plugin.application.appId,
      status: plugin.status,
    } satisfies PluginPrincipal;

    return true;
  }
}
