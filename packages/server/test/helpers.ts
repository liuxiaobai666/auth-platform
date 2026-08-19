import { INestApplication } from '@nestjs/common';
import * as crypto from 'crypto';
import request from 'supertest';

export interface PluginCreds {
  pluginId: string;
  token: string;
  secret: string;
}

export interface SignOverrides {
  timestamp?: string;
  nonce?: string;
  signature?: string;
  secret?: string;
  token?: string;
  pluginId?: string;
  idempotencyKey?: string;
}

/** 按 DEVELOPMENT.md 8.7 组装签名头。测试里也要能故意签错，所以留了覆盖项。 */
export function signHeaders(
  creds: PluginCreds, method: string, urlPath: string, body: string, o: SignOverrides = {},
): Record<string, string> {
  const timestamp = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? crypto.randomUUID();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = [method.toUpperCase(), urlPath, timestamp, nonce, bodyHash].join('\n');
  const signature =
    o.signature ?? crypto.createHmac('sha256', o.secret ?? creds.secret).update(payload).digest('hex');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${o.token ?? creds.token}`,
    'X-Plugin-Id': o.pluginId ?? creds.pluginId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
  return headers;
}

/** 发起一次已签名的插件侧请求。 */
export function pluginRequest(
  app: INestApplication, creds: PluginCreds,
  method: 'post' | 'get', urlPath: string, body?: unknown, o: SignOverrides = {},
) {
  const payload = body ? JSON.stringify(body) : '';
  const headers = signHeaders(creds, method, urlPath, payload, o);
  const req = request(app.getHttpServer())[method](urlPath).set(headers);
  if (body) req.set('Content-Type', 'application/json').send(payload);
  return req;
}

export const adminAuth = (token: string) => ({ Authorization: `Bearer ${token}` });
