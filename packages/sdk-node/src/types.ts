export interface UpgradePolicy {
  /** 为真表示不升级就不能继续使用 */
  required: boolean;
  available: boolean;
  latest_version: string | null;
  message: string | null;
  download_url: string | null;
  file_size: number | null;
  sha256: string | null;
  release_notes: string | null;
  mandatory: boolean;
}

export interface NoticePolicy {
  level: 'info' | 'warning' | 'critical';
  title: string | null;
  content: string | null;
}

export interface AppPolicy {
  app_status: 'active' | 'disabled';
  kill_switch: boolean;
  kill_message: string | null;
  maintenance: boolean;
  maintenance_message: string | null;
  min_version: string | null;
  upgrade: UpgradePolicy;
  notice: NoticePolicy | null;
  policy_ttl_seconds: number;
  server_time: string;
}

export interface ActivateResult {
  success: boolean;
  license_id: string;
  status: string;
  activated_at: string | null;
  expires_at: string | null;
  is_permanent: boolean;
  device_limit: number;
  device_count: number;
  allow_rebind: boolean;
  rebind_limit: number | null;
  rebind_remaining: number | null;
  offline_grace_hours: number;
  license_token: string;
  token_expires_at: string;
  policy: AppPolicy;
}

export interface VerifyResult {
  success: boolean;
  license_id: string;
  status: string;
  expires_at: string | null;
  is_permanent: boolean;
  offline_grace_hours: number;
  license_token: string;
  token_expires_at: string;
  policy: AppPolicy;
  /** 为真表示这次是离线宽限期内的本地放行，没有联系服务器 */
  offline?: boolean;
}

export interface StatusResult {
  success: boolean;
  license_id: string;
  status: string;
  activated_at: string | null;
  expires_at: string | null;
  is_permanent: boolean;
  device_limit: number;
  device_count: number;
  device_bound: boolean;
  allow_rebind: boolean;
  rebind_limit: number | null;
  rebind_count: number;
  offline_grace_hours: number;
}

export interface LicenseOptions {
  /** 应用标识，后台创建应用时确定 */
  appId: string;
  /** 授权中心地址，例如 https://license.example.com */
  serverUrl: string;
  pluginId: string;
  pluginToken: string;
  /**
   * 签名密钥。
   * 服务端项目对接时放在服务器环境变量里；
   * 桌面客户端无法真正保密，详见 README 的安全说明。
   */
  pluginSecret: string;

  /** 当前客户端版本，用于版本策略判断 */
  clientVersion?: string;
  /** 升级通道，默认 stable */
  channel?: 'stable' | 'beta';
  /** 覆盖设备指纹。不传则由 SDK 自动生成 */
  deviceId?: string;
  /** 设备展示名，便于用户在后台辨认自己的机器 */
  deviceName?: string;
  /** 本地状态目录，默认 ~/.jc-kami/<appId> */
  storageDir?: string;
  /** 单次请求超时毫秒数，默认 10000 */
  timeoutMs?: number;
  /** 可重试错误的最大重试次数，默认 2 */
  maxRetries?: number;

  /** 每次拿到策略时回调，用于展示公告、处理升级 */
  onPolicy?: (policy: AppPolicy) => void;
}
