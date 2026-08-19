import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { CreatePluginDto, ListPluginDto, RotateSecretDto, UpdatePluginDto } from './dto/plugin.dto';

/** 插件凭据在 Redis 的缓存键。改动或停用后必须失效，否则吊销不能立即生效。 */
export const pluginCacheKey = (pluginId: string) => `plugin:${pluginId}`;

@Injectable()
export class PluginsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
  ) {}

  async list(query: ListPluginDto) {
    const items = await this.prisma.applicationPlugin.findMany({
      where: {
        ...(query.application_id ? { applicationId: query.application_id } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { application: { select: { appId: true, name: true } } },
    });
    return { total: items.length, items: items.map((p) => this.toDto(p)) };
  }

  async detail(id: string) {
    const plugin = await this.prisma.applicationPlugin.findUnique({
      where: { id },
      include: { application: { select: { appId: true, name: true } } },
    });
    if (!plugin) throw AppException.notFound('插件不存在');
    return this.toDto(plugin);
  }

  async create(dto: CreatePluginDto) {
    const app = await this.prisma.application.findUnique({ where: { id: dto.application_id } });
    if (!app) throw AppException.notFound('应用不存在');

    const dup = await this.prisma.applicationPlugin.findUnique({ where: { pluginId: dto.plugin_id } });
    if (dup) throw new AppException(ErrorCode.CONFLICT, `plugin_id「${dto.plugin_id}」已被占用`);

    const token = `pk_${this.crypto.randomToken(24)}`;
    const secret = `sk_${this.crypto.randomToken(32)}`;

    const plugin = await this.prisma.applicationPlugin.create({
      data: {
        id: this.crypto.genId('plg'),
        pluginId: dto.plugin_id,
        applicationId: dto.application_id,
        name: dto.name,
        version: dto.version ?? '1.0.0',
        runtime: (dto.runtime ?? 'sdk') as any,
        endpoint: dto.endpoint ?? null,
        status: 'testing',
        tokenHash: this.crypto.sha256(token),
        tokenCipher: this.crypto.encrypt(token),
        tokenMasked: this.mask(token),
        secretCipher: this.crypto.encrypt(secret),
        secretMasked: this.mask(secret),
        config: (dto.config ?? {}) as any,
      },
      include: { application: { select: { appId: true, name: true } } },
    });

    // 明文只在创建响应里出现这一次，之后需要凭 plugin:write 权限单独获取
    return { ...this.toDto(plugin), credentials: { plugin_token: token, plugin_secret: secret } };
  }

  async update(id: string, dto: UpdatePluginDto) {
    const plugin = await this.prisma.applicationPlugin.findUnique({ where: { id } });
    if (!plugin) throw AppException.notFound('插件不存在');

    const updated = await this.prisma.applicationPlugin.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.version !== undefined ? { version: dto.version } : {}),
        ...(dto.runtime !== undefined ? { runtime: dto.runtime as any } : {}),
        ...(dto.endpoint !== undefined ? { endpoint: dto.endpoint } : {}),
        ...(dto.status !== undefined ? { status: dto.status as any } : {}),
        ...(dto.config !== undefined ? { config: dto.config as any } : {}),
      },
      include: { application: { select: { appId: true, name: true } } },
    });
    await this.invalidate(updated.pluginId);
    return this.toDto(updated);
  }

  /** 查看明文凭据。高危操作，调用方必须持有 plugin:write 并写审计日志。 */
  async revealCredentials(id: string) {
    const plugin = await this.prisma.applicationPlugin.findUnique({ where: { id } });
    if (!plugin) throw AppException.notFound('插件不存在');
    return {
      plugin_id: plugin.pluginId,
      plugin_token: this.crypto.decrypt(plugin.tokenCipher),
      plugin_secret: this.crypto.decrypt(plugin.secretCipher),
    };
  }

  async rotateSecret(id: string, dto: RotateSecretDto) {
    const plugin = await this.prisma.applicationPlugin.findUnique({ where: { id } });
    if (!plugin) throw AppException.notFound('插件不存在');

    const graceMinutes = dto.grace_minutes ?? 60;
    const secret = `sk_${this.crypto.randomToken(32)}`;

    const updated = await this.prisma.applicationPlugin.update({
      where: { id },
      data: {
        secretCipher: this.crypto.encrypt(secret),
        secretMasked: this.mask(secret),
        // 保留旧密钥一段时间，客户端可以分批切换而不是一刀切
        prevSecretCipher: graceMinutes > 0 ? plugin.secretCipher : null,
        prevSecretExpiresAt: graceMinutes > 0 ? new Date(Date.now() + graceMinutes * 60_000) : null,
      },
    });
    await this.invalidate(updated.pluginId);

    return {
      plugin_secret: secret,
      old_secret_valid_until: updated.prevSecretExpiresAt,
      grace_minutes: graceMinutes,
    };
  }

  async rotateToken(id: string) {
    const plugin = await this.prisma.applicationPlugin.findUnique({ where: { id } });
    if (!plugin) throw AppException.notFound('插件不存在');

    const token = `pk_${this.crypto.randomToken(24)}`;
    const updated = await this.prisma.applicationPlugin.update({
      where: { id },
      data: {
        tokenHash: this.crypto.sha256(token),
        tokenCipher: this.crypto.encrypt(token),
        tokenMasked: this.mask(token),
      },
    });
    await this.invalidate(updated.pluginId);
    // Token 没有宽限期：旧 Token 立即失效
    return { plugin_token: token };
  }

  async remove(id: string) {
    const plugin = await this.prisma.applicationPlugin.findUnique({ where: { id } });
    if (!plugin) throw AppException.notFound('插件不存在');
    await this.prisma.applicationPlugin.delete({ where: { id } });
    await this.invalidate(plugin.pluginId);
    return { success: true };
  }

  async invalidate(pluginId: string) {
    await this.redis.del(pluginCacheKey(pluginId));
  }

  private mask(secret: string): string {
    if (secret.length <= 12) return `${secret.slice(0, 3)}****`;
    return `${secret.slice(0, 7)}****${secret.slice(-4)}`;
  }

  private toDto(p: any) {
    return {
      id: p.id,
      plugin_id: p.pluginId,
      application_id: p.applicationId,
      app_id: p.application?.appId,
      app_name: p.application?.name,
      name: p.name,
      version: p.version,
      runtime: p.runtime,
      endpoint: p.endpoint,
      status: p.status,
      token_masked: p.tokenMasked,
      secret_masked: p.secretMasked,
      prev_secret_expires_at: p.prevSecretExpiresAt,
      config: p.config,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    };
  }
}
