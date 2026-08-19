import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * 在线测试器允许代理调用的开放接口白名单。
 * key 是前端可选的动作名，method/path 固定在服务端，前端无法自由构造路径。
 */
export const PLAYGROUND_ROUTES: Record<string, { method: 'GET' | 'POST'; path: string; label: string }> = {
  activate: { method: 'POST', path: '/api/v1/license/activate', label: '激活卡密' },
  verify: { method: 'POST', path: '/api/v1/license/verify', label: '验证授权' },
  deactivate: { method: 'POST', path: '/api/v1/license/deactivate', label: '解绑设备' },
  status: { method: 'GET', path: '/api/v1/license/status', label: '状态查询' },
  policy: { method: 'GET', path: '/api/v1/license/policy', label: '策略拉取' },
};

@Injectable()
export class DocsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  /** 对外基础地址：只用于示例代码展示（可能是域名）。 */
  private publicBaseUrl(): string {
    return (this.config.get<string>('PUBLIC_BASE_URL') || 'http://127.0.0.1:3100').replace(/\/+$/, '');
  }

  /**
   * 在线测试自转发的目标地址：必须走本机回环 + 实际监听端口。
   * 不能用 PUBLIC_BASE_URL——那是对外地址，可能是域名或容器外 IP，
   * 从服务端自己发起请求时未必可达。
   */
  private loopbackBaseUrl(): string {
    const port = this.config.get<string>('PORT') || '3100';
    return `http://127.0.0.1:${port}`;
  }

  /**
   * 生成填充示例代码所需的上下文：某个应用的 app_id、启用中的接入端、服务器地址。
   * 不含任何密钥——示例里的 token/secret 用占位符，真正的值让管理员去「接入凭据」取。
   */
  async context(applicationId?: string) {
    const apps = await this.prisma.application.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        plugins: {
          where: { status: { in: ['active', 'testing'] } },
          select: { pluginId: true, name: true, status: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const selected = applicationId
      ? apps.find((a) => a.id === applicationId)
      : apps[0];

    return {
      server_url: this.publicBaseUrl(),
      applications: apps.map((a) => ({
        id: a.id,
        app_id: a.appId,
        name: a.name,
        type: a.type,
        plugins: a.plugins.map((p) => ({ plugin_id: p.pluginId, name: p.name, status: p.status })),
      })),
      selected: selected
        ? {
            id: selected.id,
            app_id: selected.appId,
            name: selected.name,
            plugins: selected.plugins.map((p) => ({ plugin_id: p.pluginId, name: p.name, status: p.status })),
          }
        : null,
    };
  }

  /**
   * 返回完整接入指南 INTEGRATION.md 的 markdown 原文，供后台「完整文档」页展示与复制。
   *
   * 文档在仓库根的 docs/ 下，服务运行目录因部署方式而异，所以按几个候选路径依次探测；
   * 也可用 DOCS_DIR 环境变量显式指定，覆盖自动探测。
   */
  markdown(): { content: string; found: boolean } {
    const configured = this.config.get<string>('DOCS_DIR');
    const candidates = [
      configured && path.join(configured, 'INTEGRATION.md'),
      path.resolve(process.cwd(), 'docs/INTEGRATION.md'),
      path.resolve(process.cwd(), '../../docs/INTEGRATION.md'),
      path.resolve(__dirname, '../../../../../docs/INTEGRATION.md'),
    ].filter(Boolean) as string[];

    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          return { content: fs.readFileSync(file, 'utf8'), found: true };
        }
      } catch {
        // 无读权限等，继续试下一个候选
      }
    }
    return {
      content: '# 接入指南\n\n未能在服务器上定位到 INTEGRATION.md。请设置 DOCS_DIR 环境变量指向 docs 目录，或查看仓库中的 docs/INTEGRATION.md。',
      found: false,
    };
  }

  /** 在线测试可选的接口清单。 */
  routes() {
    return Object.entries(PLAYGROUND_ROUTES).map(([key, r]) => ({
      key, method: r.method, path: r.path, label: r.label,
    }));
  }

  /**
   * 在线测试：由服务端用应用的插件密钥签名后，转发到本机的开放 API，把真实响应返回。
   *
   * 这样设计的关键是 **plugin_secret 永远不出服务端**。前端只传「用哪个接入端、调哪个动作、
   * 什么参数」，签名在这里完成。管理员本来就能通过「查看凭据」拿到 secret，所以这里没有
   * 放大任何权限，只是省去了手动签名的麻烦。
   */
  async invoke(input: {
    pluginId: string;
    action: keyof typeof PLAYGROUND_ROUTES;
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  }) {
    const route = PLAYGROUND_ROUTES[input.action];
    if (!route) throw AppException.invalid(`不支持的测试动作：${input.action}`);

    const plugin = await this.prisma.applicationPlugin.findUnique({
      where: { pluginId: input.pluginId },
    });
    if (!plugin) throw AppException.notFound('接入端不存在');

    const secret = this.crypto.decrypt(plugin.secretCipher);
    const token = this.crypto.decrypt(plugin.tokenCipher);

    // 拼查询串：签名算的和实际发的必须是同一个字符串
    let urlPath = route.path;
    if (route.method === 'GET' && input.query) {
      const clean = Object.entries(input.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      if (clean.length) urlPath += '?' + clean.join('&');
    }

    const payload = route.method === 'POST' && input.body ? JSON.stringify(input.body) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const bodyHash = crypto.createHash('sha256').update(payload).digest('hex');
    const signPayload = [route.method, urlPath, timestamp, nonce, bodyHash].join('\n');
    const signature = crypto.createHmac('sha256', secret).update(signPayload).digest('hex');

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'X-Plugin-Id': input.pluginId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature,
    };
    if (payload) headers['Content-Type'] = 'application/json';

    const started = Date.now();
    let status: number;
    let responseBody: unknown;
    try {
      const res = await fetch(this.loopbackBaseUrl() + urlPath, {
        method: route.method,
        headers,
        body: payload || undefined,
      });
      status = res.status;
      const text = await res.text();
      try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    } catch (e) {
      throw new AppException(ErrorCode.INTERNAL_ERROR, `转发请求失败：${(e as Error).message}`);
    }

    return {
      request: {
        method: route.method,
        url: urlPath,
        // 回显发出的请求供对接人对照，但签名和 Token 只给脱敏值
        headers: {
          Authorization: `Bearer ${token.slice(0, 8)}****`,
          'X-Plugin-Id': input.pluginId,
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Signature': signature.slice(0, 16) + '…',
        },
        body: payload ? input.body : undefined,
      },
      response: { status, duration_ms: Date.now() - started, body: responseBody },
    };
  }
}
