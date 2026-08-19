import { Request } from 'express';

/** 取真实客户端 IP。反向代理下依赖 trust proxy 与 X-Forwarded-For。 */
export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return (req.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '').slice(0, 64);
}

export function userAgent(req: Request): string {
  return String(req.headers['user-agent'] ?? '').slice(0, 255);
}

/** 分页参数归一化，防止前端传入超大 pageSize 拖垮数据库。 */
export function normalizePaging(page?: number, pageSize?: number, maxPageSize = 200) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(maxPageSize, Math.max(1, Number(pageSize) || 20));
  return { page: p, pageSize: s, skip: (p - 1) * s, take: s };
}
