import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { resolveDeviceId } from './device';
import { LicenseError, LicenseErrorCode } from './errors';
import { LicenseState, SecureStorage } from './storage';
import {
  ActivateResult, AppPolicy, ConfirmResult, LicenseOptions, ReserveResult, StatusResult, VerifyResult,
} from './types';

export class LicenseClient {
  private readonly opts: Required<Pick<LicenseOptions,
    'appId' | 'serverUrl' | 'pluginId' | 'pluginToken' | 'pluginSecret'>> & LicenseOptions;
  private readonly storage: SecureStorage;
  readonly deviceId: string;

  constructor(options: LicenseOptions) {
    for (const key of ['appId', 'serverUrl', 'pluginId', 'pluginToken', 'pluginSecret'] as const) {
      if (!options[key]) throw new Error(`LicenseOptions.${key} 不能为空`);
    }
    this.opts = {
      timeoutMs: 10_000,
      maxRetries: 2,
      channel: 'stable',
      ...options,
      serverUrl: options.serverUrl.replace(/\/+$/, ''),
    };

    const dir = this.opts.storageDir ?? path.join(os.homedir(), '.jc-kami', this.opts.appId);
    this.deviceId = this.opts.deviceId ?? resolveDeviceId(path.join(dir, 'device.salt'));
    this.storage = new SecureStorage(path.join(dir, 'license.dat'), this.deviceId);
  }

  // ================================================================ 对外接口

  /** 首次激活。成功后凭据会加密保存在本地，之后调用 verify 即可。 */
  async activate(licenseKey: string, idempotencyKey?: string): Promise<ActivateResult> {
    const result = await this.request<ActivateResult>('POST', '/api/v1/license/activate', {
      app_id: this.opts.appId,
      license_key: licenseKey.trim(),
      device_id: this.deviceId,
      device_name: this.opts.deviceName ?? os.hostname(),
      client_version: this.opts.clientVersion,
      channel: this.opts.channel,
    }, idempotencyKey);

    this.persist(result.license_id, result.license_token, result.token_expires_at,
                 result.expires_at, result.offline_grace_hours);
    this.opts.onPolicy?.(result.policy);
    return result;
  }

  /**
   * 启动校验。这是客户端最常调用的方法。
   *
   * 正常路径走在线验证；网络不通时，若距上次成功验证未超过服务端下发的
   * 离线宽限期，则本地放行并在结果里标记 offline: true。
   * 超过宽限期一律拒绝 —— 不会因为「可能只是网络问题」而放行。
   */
  async verify(): Promise<VerifyResult> {
    const state = this.storage.read();
    if (!state) {
      throw new LicenseError(
        LicenseErrorCode.NOT_ACTIVATED_LOCALLY, '尚未激活，请先输入卡密激活',
      );
    }

    try {
      const result = await this.request<VerifyResult>('POST', '/api/v1/license/verify', {
        app_id: this.opts.appId,
        license_token: state.licenseToken,
        device_id: this.deviceId,
        client_version: this.opts.clientVersion,
        channel: this.opts.channel,
      });
      this.persist(state.licenseId, result.license_token, result.token_expires_at,
                   result.expires_at, result.offline_grace_hours);
      this.opts.onPolicy?.(result.policy);
      return result;
    } catch (e) {
      if (!(e instanceof LicenseError)) throw e;
      // 只有网络层失败才考虑宽限期。服务端明确拒绝（封禁、过期、关停）一律照办。
      if (e.code !== LicenseErrorCode.NETWORK_UNAVAILABLE) throw e;
      return this.fallbackOffline(state, e);
    }
  }

  /** 主动解绑当前设备，也就是「换绑」。会消耗一次换绑配额。 */
  async deactivate(reason?: string, idempotencyKey?: string): Promise<{ success: boolean }> {
    const state = this.storage.read();
    if (!state) {
      throw new LicenseError(LicenseErrorCode.NOT_ACTIVATED_LOCALLY, '本机尚未激活');
    }
    const result = await this.request<{ success: boolean }>(
      'POST', '/api/v1/license/deactivate',
      {
        app_id: this.opts.appId,
        license_token: state.licenseToken,
        device_id: this.deviceId,
        reason,
      },
      idempotencyKey,
    );
    this.storage.clear();
    return result;
  }

  // ---------------- 次数卡：两阶段消费 ----------------

  /**
   * 预扣 amount 次额度，返回 reservation_id。
   * 传 requestId（幂等键）后，超时重试同一个 requestId 不会重复冻结。
   */
  async reserve(amount = 1, requestId?: string, ttlSeconds?: number): Promise<ReserveResult> {
    const state = this.storage.read();
    if (!state) throw new LicenseError(LicenseErrorCode.NOT_ACTIVATED_LOCALLY, '尚未激活');
    return this.request<ReserveResult>('POST', '/api/v1/license/consume/reserve', {
      app_id: this.opts.appId,
      license_token: state.licenseToken,
      device_id: this.deviceId,
      amount,
      request_id: requestId,
      ttl_seconds: ttlSeconds,
    });
  }

  /** 确认预扣，把冻结的额度真正扣掉。幂等，超时可安全重试。 */
  async confirm(reservationId: string): Promise<ConfirmResult> {
    return this.request<ConfirmResult>('POST', '/api/v1/license/consume/confirm', {
      app_id: this.opts.appId,
      reservation_id: reservationId,
    });
  }

  /** 释放预扣，把冻结的额度退回（功能没执行成功时用）。 */
  async release(reservationId: string): Promise<{ success: boolean }> {
    return this.request('POST', '/api/v1/license/consume/release', {
      app_id: this.opts.appId,
      reservation_id: reservationId,
    });
  }

  /**
   * 便捷消费：自动 reserve → 执行你的业务 → 成功 confirm / 失败 release。
   * 这是次数卡最推荐的用法，正确处理了"扣了但业务失败要退回"。
   *
   * @example
   *   const r = await client.consume(1, async () => {
   *     return await doExpensiveThing();  // 你的业务
   *   });
   *   // 业务成功则已 confirm 扣次，抛错则已 release 退回
   */
  async consume<T>(amount: number, work: () => Promise<T>): Promise<T> {
    const rsv = await this.reserve(amount);
    try {
      const result = await work();
      await this.confirm(rsv.reservation_id);
      return result;
    } catch (e) {
      // 业务失败，退回额度。释放本身失败也不淹没原始错误（预扣会自动过期释放兜底）
      await this.release(rsv.reservation_id).catch(() => undefined);
      throw e;
    }
  }

  /** 查询授权状态。只读，不签发令牌，也不影响本地状态。 */
  async status(licenseKey?: string): Promise<StatusResult> {
    const state = this.storage.read();
    const query = new URLSearchParams({ app_id: this.opts.appId, device_id: this.deviceId });
    if (licenseKey) query.set('license_key', licenseKey.trim());
    else if (state) query.set('license_id', state.licenseId);
    else throw new LicenseError(LicenseErrorCode.NOT_ACTIVATED_LOCALLY, '需要提供卡密或先完成激活');

    return this.request<StatusResult>('GET', `/api/v1/license/status?${query}`);
  }

  /** 拉取远程管控策略。未激活时也能调用，用于开机就问「我还能不能跑」。 */
  async fetchPolicy(): Promise<AppPolicy> {
    const query = new URLSearchParams({ app_id: this.opts.appId, device_id: this.deviceId });
    if (this.opts.clientVersion) query.set('client_version', this.opts.clientVersion);
    if (this.opts.channel) query.set('channel', this.opts.channel);
    const res = await this.request<{ policy: AppPolicy }>('GET', `/api/v1/license/policy?${query}`);
    this.opts.onPolicy?.(res.policy);
    return res.policy;
  }

  /** 本地是否存有激活凭据。只是个快速判断，不代表授权仍然有效。 */
  hasLocalLicense(): boolean {
    try {
      return this.storage.read() !== null;
    } catch {
      return false;
    }
  }

  /** 清除本地凭据，不通知服务端。用于「退出登录」这类场景。 */
  clearLocal(): void {
    this.storage.clear();
  }

  // ================================================================ 内部

  private fallbackOffline(state: LicenseState, cause: LicenseError): VerifyResult {
    const graceMs = state.offlineGraceHours * 3600_000;
    if (graceMs <= 0) {
      throw new LicenseError(
        LicenseErrorCode.NETWORK_UNAVAILABLE,
        '当前授权要求必须联网验证，请检查网络连接',
      );
    }

    const elapsed = Date.now() - new Date(state.lastVerifiedAt).getTime();
    if (elapsed > graceMs || elapsed < 0) {
      const hours = Math.round(elapsed / 3600_000);
      throw new LicenseError(
        LicenseErrorCode.NETWORK_UNAVAILABLE,
        `已离线 ${hours} 小时，超过 ${state.offlineGraceHours} 小时宽限期，请联网后重试`,
      );
    }

    // 授权本身的到期时间也要一并检查，宽限期不能把过期的卡密续命
    if (state.expiresAt && new Date(state.expiresAt).getTime() <= Date.now()) {
      throw new LicenseError(LicenseErrorCode.LICENSE_EXPIRED, '授权已到期');
    }

    return {
      success: true,
      license_id: state.licenseId,
      status: 'active',
      expires_at: state.expiresAt,
      is_permanent: state.expiresAt === null,
      offline_grace_hours: state.offlineGraceHours,
      license_token: state.licenseToken,
      token_expires_at: state.tokenExpiresAt,
      offline: true,
      policy: {
        app_status: 'active', kill_switch: false, kill_message: null,
        maintenance: false, maintenance_message: null, min_version: null,
        upgrade: {
          required: false, available: false, latest_version: null, message: null,
          download_url: null, file_size: null, sha256: null, release_notes: null, mandatory: false,
        },
        notice: null, policy_ttl_seconds: 0, server_time: new Date().toISOString(),
      },
    };
  }

  private persist(
    licenseId: string, token: string, tokenExpiresAt: string,
    expiresAt: string | null, offlineGraceHours: number,
  ) {
    this.storage.write({
      licenseId,
      licenseToken: token,
      tokenExpiresAt,
      expiresAt,
      offlineGraceHours,
      lastVerifiedAt: new Date().toISOString(),
      deviceId: this.deviceId,
      appId: this.opts.appId,
    });
  }

  /** 按 DEVELOPMENT.md 8.7 组装签名。 */
  private sign(method: string, urlPath: string, body: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const payload = [method.toUpperCase(), urlPath, timestamp, nonce, bodyHash].join('\n');
    const signature = crypto.createHmac('sha256', this.opts.pluginSecret).update(payload).digest('hex');
    return { timestamp, nonce, signature };
  }

  private async request<T>(
    method: 'GET' | 'POST', urlPath: string,
    body?: Record<string, unknown>, idempotencyKey?: string,
  ): Promise<T> {
    const payload = body ? JSON.stringify(body) : '';
    let lastError: LicenseError | null = null;

    for (let attempt = 0; attempt <= (this.opts.maxRetries ?? 2); attempt++) {
      // 每次重试都重新签名：时间戳和 nonce 必须是新的，否则会被判定重放
      const { timestamp, nonce, signature } = this.sign(method, urlPath, payload);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.opts.pluginToken}`,
        'X-Plugin-Id': this.opts.pluginId,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': signature,
      };
      if (payload) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);

      try {
        const res = await fetch(`${this.opts.serverUrl}${urlPath}`, {
          method, headers, body: payload || undefined, signal: controller.signal,
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};

        if (res.ok) return data as T;

        const err = new LicenseError(
          data.code ?? LicenseErrorCode.INTERNAL_ERROR,
          data.message ?? `请求失败（HTTP ${res.status}）`,
          res.status, data.request_id, data.details,
        );
        if (!err.retryable || attempt === (this.opts.maxRetries ?? 2)) throw err;
        lastError = err;
        await this.backoff(attempt, err);
      } catch (e) {
        if (e instanceof LicenseError) {
          if (!e.retryable || attempt === (this.opts.maxRetries ?? 2)) throw e;
          lastError = e;
          await this.backoff(attempt, e);
          continue;
        }
        // fetch 抛错（DNS、连接被拒、超时）统一归为网络不可用，交给离线宽限期处理
        const netErr = new LicenseError(
          LicenseErrorCode.NETWORK_UNAVAILABLE,
          `无法连接授权服务器: ${(e as Error).message}`,
        );
        if (attempt === (this.opts.maxRetries ?? 2)) throw netErr;
        lastError = netErr;
        await this.backoff(attempt, netErr);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new LicenseError(LicenseErrorCode.INTERNAL_ERROR, '请求失败');
  }

  private backoff(attempt: number, err: LicenseError): Promise<void> {
    // 限流错误优先听服务端的 retry_after，其余用指数退避
    const retryAfter = Number(err.details?.retry_after ?? 0);
    const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 2 ** attempt * 500;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
