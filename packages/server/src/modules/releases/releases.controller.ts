import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res,
  UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { diskStorage } from 'multer';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AuditService } from '../../common/audit/audit.service';
import { Permission } from '../../common/auth/permissions';
import { AdminPrincipal, CurrentAdmin, Public, RequirePermissions } from '../../common/decorators';
import { CreateReleaseDto, ListReleaseDto, UpdateReleaseDto } from './dto/release.dto';
import { ReleasesService } from './releases.service';

const storageDir = (() => {
  const configured = process.env.RELEASE_STORAGE_DIR ?? './storage/releases';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
})();

@Controller('api/v1/admin/releases')
export class ReleasesController {
  constructor(
    private readonly releases: ReleasesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.RELEASE_READ)
  list(@Query() query: ListReleaseDto) {
    return this.releases.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.RELEASE_READ)
  detail(@Param('id') id: string) {
    return this.releases.detail(id);
  }

  @Post()
  @RequirePermissions(Permission.RELEASE_WRITE)
  @UseInterceptors(
    // 一个版本可以带两个包：file 是给老用户自动更新的，installer 是给新用户下载安装的
    FileFieldsInterceptor([{ name: 'file', maxCount: 1 }, { name: 'installer', maxCount: 1 }], {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          fs.mkdirSync(storageDir, { recursive: true });
          cb(null, storageDir);
        },
        // 落盘文件名用随机值，不采信客户端提供的名字，避免路径穿越和覆盖
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).slice(0, 16).replace(/[^\w.]/g, '');
          cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
        },
      }),
      limits: { fileSize: Number(process.env.RELEASE_MAX_SIZE_MB ?? 2048) * 1024 * 1024 },
    }),
  )
  async create(
    @Body() dto: CreateReleaseDto,
    @UploadedFiles()
    files: { file?: Express.Multer.File[]; installer?: Express.Multer.File[] } | undefined,
    @CurrentAdmin() admin: AdminPrincipal,
    @Req() req: Request,
  ) {
    const release = await this.releases.create(
      dto, files?.file?.[0], admin.id, files?.installer?.[0],
    );
    await this.audit.record(req, {
      action: 'release.create', targetType: 'release', targetId: release.id,
      detail: {
        app_id: release.app_id, version: release.version, channel: release.channel,
        file_size: release.file_size, sha256: release.sha256,
        installer_size: release.installer_size,
      },
    });
    return release;
  }

  @Patch(':id')
  @RequirePermissions(Permission.RELEASE_WRITE)
  async update(@Param('id') id: string, @Body() dto: UpdateReleaseDto, @Req() req: Request) {
    const release = await this.releases.update(id, dto);
    await this.audit.record(req, {
      action: 'release.update', targetType: 'release', targetId: id, detail: { ...dto },
    });
    return release;
  }

  @HttpCode(200)
  @Post(':id/publish')
  @RequirePermissions(Permission.RELEASE_WRITE)
  async publish(
    @Param('id') id: string,
    @Body('rollout_percent') rolloutPercent: number | undefined,
    @Req() req: Request,
  ) {
    const release = await this.releases.publish(id, rolloutPercent);
    await this.audit.record(req, {
      action: 'release.publish', targetType: 'release', targetId: id,
      detail: { version: release.version, rollout_percent: release.rollout_percent },
    });
    return release;
  }

  @HttpCode(200)
  @Post(':id/archive')
  @RequirePermissions(Permission.RELEASE_WRITE)
  async archive(@Param('id') id: string, @Req() req: Request) {
    const release = await this.releases.archive(id);
    await this.audit.record(req, { action: 'release.archive', targetType: 'release', targetId: id });
    return release;
  }

  @Delete(':id')
  @RequirePermissions(Permission.RELEASE_WRITE)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const result = await this.releases.remove(id);
    await this.audit.record(req, { action: 'release.delete', targetType: 'release', targetId: id });
    return result;
  }
}

/**
 * 安装包下载。这是唯一对外公开的非签名接口：
 * 下载地址会直接交给客户端，加签名反而让浏览器和下载器无法使用。
 * 防护手段是「只有已发布版本可下」加上不可枚举的随机 ID。
 */
@Public()
@Controller('api/v1/releases')
export class ReleaseDownloadController {
  constructor(private readonly releases: ReleasesService) {}

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const result = await this.releases.resolveDownload(id);
    if ('redirect' in result) return res.redirect(302, result.redirect);
    return res.download(result.file, result.fileName);
  }
}
