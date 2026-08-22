/** 安装包形态。SDK 拿到这份描述就知道该怎么把包落到磁盘上。 */
export interface UpdatePackageInfo {
  /** zip：普通压缩包；onefile：包本身就是可执行文件；onedir：目录形态的构建产物 */
  type: 'zip' | 'onefile' | 'onedir' | string;
  /**
   * versioned：装进 versions/<版本>/ 再切指针（默认）；
   * replace：同上，由宿主决定何时覆盖运行目录；
   * notify：只提示，安装交给宿主自己处理（Electron autoUpdater 等），SDK 不动手。
   */
  install_strategy: 'versioned' | 'replace' | 'notify' | string;
  /** 包内多套了一层顶层目录时剥掉它。只有所有条目共享同一个顶层目录才会真的剥 */
  strip_root_dir: boolean;
  /** 入口文件名，例如 app.exe / main.js */
  entry: string | null;
  /** 安装后命令。不在签名保护范围内，默认不执行 */
  post_install: string | null;
}

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
  /** 安装包形态描述，老服务端可能没有 */
  package?: UpdatePackageInfo | null;
  /** Ed25519 签名（base64）。公钥必须内置在客户端，服务端不会下发 */
  signature?: string | null;
}

export interface UpdaterOptions {
  /** 应用根目录，versions/ 和 current.txt 都放在这里 */
  root: string;
  /**
   * 应用的验签公钥（裸 32 字节的 base64），必须内置在客户端里。
   * 绝不能从服务端下发——那样篡改响应的人可以连公钥一起换。
   */
  publicKey: string;
  /** 保留几个历史版本（含当前版本），用于回滚。默认 2 */
  keepVersions?: number;
  /** 下载超时毫秒数，默认 60000 */
  timeout?: number;
  /**
   * 下载安装包时发送的 User-Agent，默认 `jc-kami-updater/1.0`。
   *
   * Node 的 fetch 默认发 `node`，很多 CDN/WAF（如 Cloudflare 的浏览器完整性检查）
   * 会把这类非浏览器标识判成机器人直接返回 403，下载根本到不了服务端。
   * 传成和授权请求一致的 UA 最稳，WAF 规则只需放行一个标识。
   */
  userAgent?: string;
}

export interface ApplyOptions {
  /** 下载进度回调，(已收字节, 总字节)。总字节未知时为 0 */
  progress?: (received: number, total: number) => void;
  /**
   * 是否执行安装后命令。默认 false：
   * 这条命令来自服务端且不在签名保护范围内，一旦响应被篡改就等于任意代码执行。
   */
  allowPostInstall?: boolean;
  /** 安装完成后尝试重启到新版本 */
  restart?: boolean;
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

export interface ReserveResult {
  success: boolean;
  reservation_id: string;
  status: string;
  amount: number;
  expires_at: string;
  quota_total: number | null;
  quota_used: number;
  quota_available: number | null;
}

export interface ConfirmResult {
  success: boolean;
  reservation_id: string;
  status: string;
  amount: number;
  replayed: boolean;
  quota_total: number | null;
  quota_used: number;
  quota_available: number | null;
}
