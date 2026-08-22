import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { normalizePaging } from '../../common/utils/request.util';
import { compareVersion, isValidVersion } from '../../common/utils/version.util';
import { PluginsService } from '../plugins/plugins.service';
import { ReleasesService } from '../releases/releases.service';
import {
  CreateApplicationDto, ListApplicationDto, UpdateApplicationDto, UpdatePolicyDto,
} from './dto/application.dto';

/** 应用策略在 Redis 里的缓存键。改动策略后必须失效，否则远程关停不能立刻生效。 */
export const policyCacheKey = (appId: string) => `policy:${appId}`;

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    private readonly plugins: PluginsService,
    private readonly releases: ReleasesService,
  ) {}

  async list(query: ListApplicationDto) {
    const { page, pageSize, skip, take } = normalizePaging(query.page, query.page_size);
    const where: Prisma.ApplicationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.keyword
        ? {
            OR: [
              { appId: { contains: query.keyword } },
              { name: { contains: query.keyword } },
            ],
          }
        : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.application.count({ where }),
      this.prisma.application.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { _count: { select: { plugins: true, plans: true, licenseKeys: true } } },
      }),
    ]);

    return {
      total, page, page_size: pageSize,
      items: items.map((a) => this.toBrief(a)),
    };
  }

  async detail(id: string) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: { _count: { select: { plugins: true, plans: true, licenseKeys: true } } },
    });
    if (!app) throw AppException.notFound('应用不存在');
    return this.toDetail(app);
  }

  /**
   * 创建应用。默认同时生成一副接入凭据。
   *
   * 「应用」和「插件」是两层：应用是你卖的产品，卡密、套餐、远程管控都挂在它上面；
   * 插件是某一个接入端持有的一副钥匙，分开是为了让吊销的粒度小于整个产品
   * （Windows 端密钥泄露时不必把网页端一起打死）。
   * 但绝大多数应用只有一个端，所以这里默认替调用方把第一副钥匙配好。
   */
  async create(dto: CreateApplicationDto, opts: { withDefaultPlugin: boolean }) {
    const exists = await this.prisma.application.findUnique({ where: { appId: dto.app_id } });
    if (exists) throw new AppException(ErrorCode.CONFLICT, `app_id「${dto.app_id}」已被占用`);

    // 建应用时就生成更新包签名密钥：开发者打包客户端之前就得拿到公钥内置进去
    const signKeys = this.crypto.generateSignKeyPair();
    const app = await this.prisma.application.create({
      data: {
        id: this.crypto.genId('app'),
        appId: dto.app_id,
        name: dto.name,
        type: (dto.type ?? 'windows') as any,
        remark: dto.remark ?? null,
        updateSignPublicKey: signKeys.publicKey,
        updateSignPrivateKey: this.crypto.encrypt(signKeys.privateKey),
      },
    });

    let defaultPlugin: unknown = null;
    if (opts.withDefaultPlugin) {
      defaultPlugin = await this.plugins.create({
        application_id: app.id,
        plugin_id: `${dto.app_id}_default`,
        name: `${dto.name} 默认接入端`,
        runtime: 'sdk' as any,
      });
    }

    return { ...this.toDetail(app), default_plugin: defaultPlugin };
  }

  async update(id: string, dto: UpdateApplicationDto) {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw AppException.notFound('应用不存在');

    const updated = await this.prisma.application.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type as any } : {}),
        ...(dto.status !== undefined ? { status: dto.status as any } : {}),
        ...(dto.remark !== undefined ? { remark: dto.remark } : {}),
      },
    });
    await this.invalidatePolicy(updated.appId);
    return this.toDetail(updated);
  }

  /**
   * 更新远程管控策略。这是高危操作：kill_switch 一旦打开，
   * 该应用所有客户端的验证请求会立即被拒绝。
   */
  async updatePolicy(id: string, dto: UpdatePolicyDto) {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw AppException.notFound('应用不存在');

    for (const [field, value] of [
      ['min_version', dto.min_version],
      ['latest_version', dto.latest_version],
    ] as const) {
      if (value !== undefined && value !== '' && !isValidVersion(value)) {
        throw AppException.invalid(`${field} 不是合法的版本号：${value}`);
      }
    }

    // 最低版本高于最新版本会让所有客户端卡死在「必须升级但没有可升级的版本」
    if (dto.min_version && dto.latest_version &&
        compareVersion(dto.min_version, dto.latest_version) > 0) {
      throw AppException.invalid('min_version 不能高于 latest_version，否则所有客户端都将无法通过校验');
    }

    const updated = await this.prisma.application.update({
      where: { id },
      data: {
        ...(dto.kill_switch !== undefined ? { killSwitch: dto.kill_switch } : {}),
        ...(dto.kill_message !== undefined ? { killMessage: dto.kill_message } : {}),
        ...(dto.maintenance !== undefined ? { maintenance: dto.maintenance } : {}),
        ...(dto.maintenance_message !== undefined ? { maintenanceMessage: dto.maintenance_message } : {}),
        ...(dto.min_version !== undefined ? { minVersion: dto.min_version || null } : {}),
        ...(dto.latest_version !== undefined ? { latestVersion: dto.latest_version || null } : {}),
        ...(dto.force_upgrade !== undefined ? { forceUpgrade: dto.force_upgrade } : {}),
        ...(dto.upgrade_message !== undefined ? { upgradeMessage: dto.upgrade_message } : {}),
        ...(dto.notice_enabled !== undefined ? { noticeEnabled: dto.notice_enabled } : {}),
        ...(dto.notice_level !== undefined ? { noticeLevel: dto.notice_level as any } : {}),
        ...(dto.notice_title !== undefined ? { noticeTitle: dto.notice_title } : {}),
        ...(dto.notice_content !== undefined ? { noticeContent: dto.notice_content } : {}),
        ...(dto.policy_ttl_seconds !== undefined ? { policyTtlSeconds: dto.policy_ttl_seconds } : {}),
      },
    });

    await this.invalidatePolicy(updated.appId);
    return this.toDetail(updated);
  }

  async remove(id: string) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: { _count: { select: { licenseKeys: true } } },
    });
    if (!app) throw AppException.notFound('应用不存在');
    if (app._count.licenseKeys > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `该应用下还有 ${app._count.licenseKeys} 个卡密，不能删除。如需停止服务请改用停用或远程关停`,
      );
    }

    // 必须先删磁盘文件再删记录。app_releases 上挂着 onDelete: Cascade，
    // 数据库会直接把版本行清掉，服务层再也查不到 filePath，安装包就永远留在盘上了。
    const removedFiles = await this.releases.purgeFilesOfApplication(id);

    await this.prisma.application.delete({ where: { id } });
    await this.invalidatePolicy(app.appId);
    return { success: true, removed_files: removedFiles };
  }

  async invalidatePolicy(appId: string) {
    await this.redis.del(policyCacheKey(appId));
  }

  private toBrief(a: any) {
    return {
      id: a.id,
      app_id: a.appId,
      name: a.name,
      type: a.type,
      status: a.status,
      kill_switch: a.killSwitch,
      maintenance: a.maintenance,
      latest_version: a.latestVersion,
      min_version: a.minVersion,
      remark: a.remark,
      counts: a._count
        ? { plugins: a._count.plugins, plans: a._count.plans, licenses: a._count.licenseKeys }
        : undefined,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    };
  }

  private toDetail(a: any) {
    return {
      ...this.toBrief(a),
      policy: {
        kill_switch: a.killSwitch,
        kill_message: a.killMessage,
        maintenance: a.maintenance,
        maintenance_message: a.maintenanceMessage,
        min_version: a.minVersion,
        latest_version: a.latestVersion,
        force_upgrade: a.forceUpgrade,
        upgrade_message: a.upgradeMessage,
        notice_enabled: a.noticeEnabled,
        notice_level: a.noticeLevel,
        notice_title: a.noticeTitle,
        notice_content: a.noticeContent,
        policy_ttl_seconds: a.policyTtlSeconds,
      },
      // 更新包验签公钥。公钥本就是公开信息，开发者要把它内置进客户端；
      // 对应私钥只以密文留在服务端，任何接口都不会返回。
      update_sign_public_key: a.updateSignPublicKey,
    };
  }
}
