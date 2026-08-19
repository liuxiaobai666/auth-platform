import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import * as crypto from 'crypto';

/**
 * 每个请求分配一个 request_id，写入响应头并贯穿错误响应与所有日志表，
 * 便于按 ID 把客户端报错和服务端日志对上。
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming)
        ? incoming
        : `req_${crypto.randomBytes(12).toString('hex')}`;
    (req as any).requestId = id;
    (req as any).startedAt = Date.now();
    res.setHeader('X-Request-Id', id);
    next();
  }
}
