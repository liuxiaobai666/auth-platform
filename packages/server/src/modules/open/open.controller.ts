import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CurrentPlugin, Public, PluginPrincipal } from '../../common/decorators';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { RateLimitService } from '../../common/ratelimit/rate-limit.service';
import { clientIp } from '../../common/utils/request.util';
import { ConfirmDto, ReleaseDto, ReserveDto } from './dto/consume.dto';
import { ActivateDto, DeactivateDto, PolicyQueryDto, StatusQueryDto, VerifyDto } from './dto/open.dto';
import { PluginSignatureGuard } from './guards/plugin-signature.guard';
import { ActivationService } from './services/activation.service';
import { ConsumeService } from './services/consume.service';
import { IdempotencyService } from './services/idempotency.service';

/**
 * 插件侧开放接口。
 * @Public 只是跳过管理员登录态校验，真正的认证由 PluginSignatureGuard 完成。
 */
@Public()
@UseGuards(PluginSignatureGuard)
@Controller('api/v1/license')
export class OpenController {
  constructor(
    private readonly activation: ActivationService,
    private readonly consume: ConsumeService,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @HttpCode(200)
  @Post('activate')
  async activate(
    @Body() dto: ActivateDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Headers('idempotency-key') idemKey: string | undefined,
    @Req() req: Request,
  ) {
    const ip = clientIp(req);
    await this.rateLimit.consume('activate', [
      { dimension: 'ip', key: ip, limit: 60, windowSeconds: 60 },
      { dimension: 'plugin', key: plugin.pluginId, limit: 600, windowSeconds: 60 },
      { dimension: 'device', key: dto.device_id, limit: 10, windowSeconds: 60 },
    ]);

    // 卡密本身有约 122 位熵，暴力枚举在数学上不可行；这里再加一道针对
    // 「卡密不存在」失败的独立计数，把枚举探测的成本进一步抬高。
    // gate 只读不自增（limit=0 时 consume 会在计数已达阈值时拦截）；
    // 真正的自增只发生在下面「卡密不存在」的失败回填里，所以阈值就是
    // 实打实的失败次数：同一 IP 5 分钟累计 30 次「卡密不存在」即拦截，
    // 正常用户几乎不可能触发。
    await this.rateLimit.gate('activate_miss', 'ip', ip, 30);

    try {
      return await this.withIdempotency(plugin, 'activate', idemKey, req, () =>
        this.activation.activate(plugin, dto, req),
      );
    } catch (e) {
      // 只有「卡密不存在」才回填失败计数——这是枚举的典型信号；
      // 已存在但状态不对（过期/封禁）不算，避免误伤正常用户的正常报错
      if (e instanceof AppException && e.code === ErrorCode.LICENSE_NOT_FOUND) {
        await this.rateLimit
          .penalize('activate_miss', 'ip', ip, 300)
          .catch(() => undefined);
      }
      throw e;
    }
  }

  @HttpCode(200)
  @Post('verify')
  async verify(
    @Body() dto: VerifyDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Req() req: Request,
  ) {
    await this.rateLimit.consume('verify', [
      { dimension: 'ip', key: clientIp(req), limit: 300, windowSeconds: 60 },
      { dimension: 'plugin', key: plugin.pluginId, limit: 3000, windowSeconds: 60 },
      { dimension: 'device', key: dto.device_id, limit: 60, windowSeconds: 60 },
    ]);
    return this.activation.verify(plugin, dto, req);
  }

  @HttpCode(200)
  @Post('deactivate')
  async deactivate(
    @Body() dto: DeactivateDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Headers('idempotency-key') idemKey: string | undefined,
    @Req() req: Request,
  ) {
    await this.rateLimit.consume('deactivate', [
      { dimension: 'ip', key: clientIp(req), limit: 30, windowSeconds: 60 },
      { dimension: 'device', key: dto.device_id, limit: 5, windowSeconds: 300 },
    ]);
    return this.withIdempotency(plugin, 'deactivate', idemKey, req, () =>
      this.activation.deactivate(plugin, dto, req),
    );
  }

  @Get('status')
  async status(
    @Query() query: StatusQueryDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Req() req: Request,
  ) {
    await this.rateLimit.consume('status', [
      { dimension: 'ip', key: clientIp(req), limit: 120, windowSeconds: 60 },
    ]);
    return this.activation.status(
      plugin, query.app_id, query.license_id, query.license_key, query.device_id, req,
    );
  }

  /** 不带卡密的策略拉取：客户端启动时先问一句「我还能不能跑、要不要升级」。 */
  @Get('policy')
  async policy(
    @Query() query: PolicyQueryDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Req() req: Request,
  ) {
    await this.rateLimit.consume('policy', [
      { dimension: 'ip', key: clientIp(req), limit: 120, windowSeconds: 60 },
    ]);
    return this.activation.policyOnly(
      plugin, query.app_id, query.client_version, query.device_id, query.channel, req,
    );
  }

  // ---------------- 次数卡：两阶段消费 ----------------

  /** 预扣：冻结 amount 次额度，返回 reservation_id。幂等键防重复冻结。 */
  @HttpCode(200)
  @Post('consume/reserve')
  async reserve(
    @Body() dto: ReserveDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Req() req: Request,
  ) {
    await this.rateLimit.consume('consume', [
      { dimension: 'ip', key: clientIp(req), limit: 600, windowSeconds: 60 },
      { dimension: 'device', key: dto.device_id, limit: 300, windowSeconds: 60 },
    ]);
    return this.consume.reserve(plugin, dto, req);
  }

  /** 确认：把预扣转为真实扣减。幂等，超时可安全重试。 */
  @HttpCode(200)
  @Post('consume/confirm')
  async confirmConsume(
    @Body() dto: ConfirmDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Req() req: Request,
  ) {
    return this.consume.confirm(plugin, dto, req);
  }

  /** 释放：功能没执行成功，把预扣的额度退回。 */
  @HttpCode(200)
  @Post('consume/release')
  async releaseConsume(
    @Body() dto: ReleaseDto,
    @CurrentPlugin() plugin: PluginPrincipal,
    @Req() req: Request,
  ) {
    return this.consume.release(plugin, dto, req);
  }

  /**
   * 写操作的幂等包装。没带幂等键就直接执行，
   * 带了就先查缓存结果，避免重复激活或重复扣换绑次数。
   */
  private async withIdempotency(
    plugin: PluginPrincipal, endpoint: string, idemKey: string | undefined,
    req: Request, fn: () => Promise<unknown>,
  ) {
    if (!idemKey) return fn();

    const rawBody = (req as any).rawBody as Buffer | undefined;
    const cached = await this.idempotency.lookup(plugin.pluginId, endpoint, idemKey, rawBody);
    if (cached !== null) return cached;

    const result = await fn();
    await this.idempotency.save(plugin.pluginId, endpoint, idemKey, rawBody, 200, result);
    return result;
  }
}
