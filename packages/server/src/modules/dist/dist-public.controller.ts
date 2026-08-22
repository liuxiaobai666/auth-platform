import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { RateLimitService } from '../../common/ratelimit/rate-limit.service';
import { clientIp } from '../../common/utils/request.util';
import { DistService } from './dist.service';
import { UnlockDto } from './dto/dist.dto';

/** 对外分发页。全部公开访问，不需要任何凭据。 */
@Public()
@Controller()
export class DistPublicController {
  constructor(
    private readonly dist: DistService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** 下载页本体。 */
  @Get('d/:slug')
  async page(@Param('slug') slug: string, @Res() res: Response, @Req() req: Request) {
    await this.rateLimit.consume('dist_page', [
      { dimension: 'ip', key: clientIp(req), limit: 120, windowSeconds: 60 },
    ]);
    const html = await this.dist.renderPage(slug);
    res.type('html').send(html);
  }

  /**
   * 验卡换下载票据。
   *
   * 这是个公开接口，天然是刷卡密的靶子：除了常规频率限制，
   * 连续验失败还会被拉进更严的闸门，让批量试卡跑不动。
   */
  @HttpCode(200)
  @Post('api/v1/pub/dist/:slug/unlock')
  async unlock(@Param('slug') slug: string, @Body() dto: UnlockDto, @Req() req: Request) {
    const ip = clientIp(req);
    await this.rateLimit.consume('dist_unlock', [
      { dimension: 'ip', key: ip, limit: 20, windowSeconds: 60 },
    ]);
    await this.rateLimit.gate('dist_unlock_miss', 'ip', ip, 20);

    try {
      return await this.dist.unlock(slug, dto.license_key ?? '');
    } catch (err) {
      if (
        err instanceof AppException &&
        [
          ErrorCode.LICENSE_NOT_FOUND,
          ErrorCode.LICENSE_EXPIRED,
          ErrorCode.LICENSE_BANNED,
          ErrorCode.LICENSE_REVOKED,
        ].includes(err.code as any)
      ) {
        await this.rateLimit.penalize('dist_unlock_miss', 'ip', ip, 600);
      }
      throw err;
    }
  }

  /** 凭票据下载安装包。 */
  @Get('api/v1/pub/dist/:slug/download')
  async download(
    @Param('slug') slug: string,
    @Query('t') ticket: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    await this.rateLimit.consume('dist_download', [
      { dimension: 'ip', key: clientIp(req), limit: 30, windowSeconds: 60 },
    ]);

    // 外链形态不经过本站的流量，直接把用户送过去
    const external = await this.dist.externalUrl(slug, ticket);
    if (external) return res.redirect(302, external);

    const target = await this.dist.resolveDownload(slug, ticket);
    return res.download(target.file, target.fileName);
  }
}
