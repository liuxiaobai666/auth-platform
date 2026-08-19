import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { compareVersion } from '../../common/utils/version.util';
import { CreateReleaseDto, ListReleaseDto, UpdateReleaseDto } from './dto/release.dto';

/** 下载目标：要么重定向到外部地址，要么回本地文件。 */
export type DownloadTarget =
  | { redirect: string }
  | { file: string; fileName: string; size: number };

@Injectable()
export class ReleasesService {
  private readonly logger = new Logger('Releases');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  get storageDir(): string {
    const configured = this.config.get<string>('RELEASE_STORAGE_DIR') ?? './storage/releases';
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  async list(query: ListReleaseDto) {
    const items = await this.prisma.appRelease.findMany({
      where: {
        ...(query.application_id ? { applicationId: query.application_id } : {}),
        ...(query.channel ? { channel: query.channel as any } : {}),
        ...(query.status ? { status: query.status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { application: { select: { appId: true, name: true } } },
    });
    // 按版本号从高到低展示，发布时间顺序和版本顺序不一致时也不会看错
    items.sort((a, b) => compareVersion(b.version, a.version));
    return { total: items.length, items: items.map((r) => this.toDto(r)) };
  }

  async detail(id: string) {
    const release = await this.prisma.appRelease.findUnique({
      where: { id },
      include: { application: { select: { appId: true, name: true } } },
    });
    if (!release) throw AppException.notFound('版本不存在');
    return this.toDto(release);
  }

  async create(dto: CreateReleaseDto, file: Express.Multer.File | undefined, adminId: string) {
    const app = await this.prisma.application.findUnique({ where: { id: dto.application_id } });
    if (!app) {
      if (file) await this.safeUnlink(file.path);
      throw AppException.notFound('应用不存在');
    }

    const channel = dto.channel ?? 'stable';
    const dup = await this.prisma.appRelease.findUnique({
      where: {
        applicationId_version_channel: {
          applicationId: dto.application_id, version: dto.version, channel: channel as any,
        },
      },
    });
    if (dup) {
      if (file) await this.safeUnlink(file.path);
      throw new AppException(ErrorCode.CONFLICT, `${channel} 通道下版本 ${dto.version} 已存在`);
    }
    if (!file && !dto.external_url) {
      throw AppException.invalid('必须上传安装包文件或提供 external_url');
    }

    let sha256: string | null = null;
    if (file) {
      sha256 = await this.hashFile(file.path);
    }

    const release = await this.prisma.appRelease.create({
      data: {
        id: this.crypto.genId('rel'),
        applicationId: dto.application_id,
        version: dto.version,
        channel: channel as any,
        fileName: file?.originalname ?? null,
        filePath: file ? path.relative(this.storageDir, file.path) : null,
        fileSize: file ? BigInt(file.size) : null,
        sha256,
        externalUrl: dto.external_url ?? null,
        releaseNotes: dto.release_notes ?? null,
        isMandatory: dto.is_mandatory ?? false,
        rolloutPercent: dto.rollout_percent ?? 100,
        // 新建默认是草稿，必须显式发布才会下发给客户端
        status: 'draft',
        createdBy: adminId,
      },
      include: { application: { select: { appId: true, name: true } } },
    });
    return this.toDto(release);
  }

  async update(id: string, dto: UpdateReleaseDto) {
    const release = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!release) throw AppException.notFound('版本不存在');

    const updated = await this.prisma.appRelease.update({
      where: { id },
      data: {
        ...(dto.release_notes !== undefined ? { releaseNotes: dto.release_notes } : {}),
        ...(dto.is_mandatory !== undefined ? { isMandatory: dto.is_mandatory } : {}),
        ...(dto.rollout_percent !== undefined ? { rolloutPercent: dto.rollout_percent } : {}),
        ...(dto.external_url !== undefined ? { externalUrl: dto.external_url } : {}),
        ...(dto.status !== undefined
          ? {
              status: dto.status as any,
              publishedAt:
                dto.status === 'published' && !release.publishedAt ? new Date() : release.publishedAt,
            }
          : {}),
      },
      include: { application: { select: { appId: true, name: true } } },
    });
    return this.toDto(updated);
  }

  /**
   * 发布。默认按 rollout_percent 灰度放量，
   * 同时把应用的 latest_version 指向该版本，后台一眼能看出当前主推版本。
   */
  async publish(id: string, rolloutPercent?: number) {
    const release = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!release) throw AppException.notFound('版本不存在');
    if (!release.filePath && !release.externalUrl) {
      throw AppException.invalid('该版本既没有安装包也没有下载地址，不能发布');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.appRelease.update({
        where: { id },
        data: {
          status: 'published',
          publishedAt: release.publishedAt ?? new Date(),
          ...(rolloutPercent !== undefined ? { rolloutPercent } : {}),
        },
        include: { application: { select: { appId: true, name: true } } },
      }),
      this.prisma.application.update({
        where: { id: release.applicationId },
        data: { latestVersion: release.version },
      }),
    ]);
    return this.toDto(updated);
  }

  async archive(id: string) {
    const release = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!release) throw AppException.notFound('版本不存在');
    const updated = await this.prisma.appRelease.update({
      where: { id },
      data: { status: 'archived' },
      include: { application: { select: { appId: true, name: true } } },
    });
    return this.toDto(updated);
  }

  async remove(id: string) {
    const release = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!release) throw AppException.notFound('版本不存在');
    if (release.status === 'published') {
      throw new AppException(ErrorCode.CONFLICT, '已发布的版本不能直接删除，请先归档');
    }
    if (release.filePath) {
      await this.safeUnlink(path.join(this.storageDir, release.filePath));
    }
    await this.prisma.appRelease.delete({ where: { id } });
    return { success: true };
  }

  /** 下载。只有已发布版本可下载，并做路径逃逸防护。 */
  async resolveDownload(id: string): Promise<DownloadTarget> {
    const release = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!release) throw AppException.notFound('版本不存在');
    if (release.status !== 'published') {
      throw new AppException(ErrorCode.FORBIDDEN, '该版本尚未发布');
    }
    if (release.externalUrl) return { redirect: release.externalUrl };
    if (!release.filePath) throw AppException.notFound('该版本没有可下载的文件');

    const abs = path.resolve(this.storageDir, release.filePath);
    // filePath 来自数据库，仍然要防止被构造出跳出存储目录的相对路径
    if (!abs.startsWith(path.resolve(this.storageDir) + path.sep)) {
      throw new AppException(ErrorCode.INTERNAL_ERROR, '安装包路径异常');
    }
    if (!fs.existsSync(abs)) {
      this.logger.error(`安装包文件缺失: ${abs}`);
      throw AppException.notFound('安装包文件不存在，请重新上传');
    }

    await this.prisma.appRelease
      .update({ where: { id }, data: { downloadCount: { increment: 1 } } })
      .catch(() => undefined);

    return { file: abs, fileName: release.fileName ?? path.basename(abs), size: Number(release.fileSize ?? 0) };
  }

  /**
   * 删除某个应用名下所有版本的磁盘文件，返回删除的文件数。
   *
   * 供删除应用时调用：数据库层的级联删除会先把 app_releases 行清掉，
   * 之后就再也查不到 filePath，安装包会变成谁也管不着的孤儿文件。
   */
  async purgeFilesOfApplication(applicationId: string): Promise<number> {
    const releases = await this.prisma.appRelease.findMany({
      where: { applicationId, filePath: { not: null } },
      select: { filePath: true },
    });

    let removed = 0;
    for (const r of releases) {
      const abs = path.resolve(this.storageDir, r.filePath!);
      // filePath 来自数据库，仍要防止构造出跳出存储目录的相对路径
      if (!abs.startsWith(path.resolve(this.storageDir) + path.sep)) continue;
      if (!fs.existsSync(abs)) continue;
      await this.safeUnlink(abs);
      removed++;
    }
    if (removed) this.logger.log(`应用 ${applicationId} 删除时清理了 ${removed} 个安装包文件`);
    return removed;
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async safeUnlink(p: string) {
    await fs.promises.unlink(p).catch(() => undefined);
  }

  private toDto(r: any) {
    return {
      id: r.id,
      application_id: r.applicationId,
      app_id: r.application?.appId,
      app_name: r.application?.name,
      version: r.version,
      channel: r.channel,
      status: r.status,
      file_name: r.fileName,
      file_size: r.fileSize ? Number(r.fileSize) : null,
      sha256: r.sha256,
      external_url: r.externalUrl,
      release_notes: r.releaseNotes,
      is_mandatory: r.isMandatory,
      rollout_percent: r.rolloutPercent,
      download_count: r.downloadCount,
      published_at: r.publishedAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  }
}
