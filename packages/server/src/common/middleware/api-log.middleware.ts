import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { clientIp, userAgent } from '../utils/request.util';

/**
 * API 请求日志。挂在响应的 finish 事件上，这样拿到的一定是真实发出的状态码；
 * 用拦截器的话，异常分支会在过滤器写响应之前触发，状态码还是默认值。
 *
 * 只记录元数据，绝不记录请求体，避免卡密原文、Token 和设备指纹落到日志表。
 */
@Injectable()
export class ApiLogMiddleware implements NestMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    res.on('finish', () => {
      const startedAt = (req as any).startedAt ?? Date.now();
      void this.prisma.apiRequestLog
        .create({
          data: {
            id: this.crypto.genId('log'),
            requestId: (req as any).requestId ?? '-',
            method: req.method,
            path: (req.originalUrl ?? req.url).split('?')[0].slice(0, 255),
            pluginId: (req as any).plugin?.pluginId ?? null,
            adminUserId: (req as any).admin?.id ?? null,
            statusCode: res.statusCode,
            code: (req as any).errorCode ?? null,
            durationMs: Date.now() - startedAt,
            ip: clientIp(req),
            userAgent: userAgent(req),
          },
        })
        .catch(() => undefined); // 日志失败不能影响主流程
    });
    next();
  }
}
