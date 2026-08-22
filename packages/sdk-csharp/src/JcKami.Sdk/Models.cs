using System.Text.Json.Serialization;

namespace JcKami
{
    /// <summary>升级策略。</summary>
    public class UpgradePolicy
    {
        /// <summary>为真表示不升级就不能继续使用，客户端应当阻断启动。</summary>
        [JsonPropertyName("required")] public bool Required { get; set; }

        /// <summary>有更新版本可用，但不一定强制。</summary>
        [JsonPropertyName("available")] public bool Available { get; set; }

        [JsonPropertyName("latest_version")] public string LatestVersion { get; set; }
        [JsonPropertyName("message")] public string Message { get; set; }
        [JsonPropertyName("download_url")] public string DownloadUrl { get; set; }
        [JsonPropertyName("file_size")] public long? FileSize { get; set; }

        /// <summary>安装包的 SHA-256。下载后务必校验再执行。</summary>
        [JsonPropertyName("sha256")] public string Sha256 { get; set; }

        [JsonPropertyName("release_notes")] public string ReleaseNotes { get; set; }
        [JsonPropertyName("mandatory")] public bool Mandatory { get; set; }

        /// <summary>安装包形态与安装策略。</summary>
        [JsonPropertyName("package")] public PackagePolicy Package { get; set; }

        /// <summary>
        /// 平台用应用私钥对「版本 + 哈希 + 大小」签的 Ed25519 签名（base64）。
        /// 哈希只能防传输损坏，防不了篡改 —— 能改安装包的人同样能改哈希，
        /// 只有私钥签的名他伪造不了。
        /// </summary>
        [JsonPropertyName("signature")] public string Signature { get; set; }
    }

    /// <summary>安装包描述。</summary>
    public class PackagePolicy
    {
        /// <summary>zip / onefile / onedir</summary>
        [JsonPropertyName("type")] public string Type { get; set; }

        /// <summary>versioned（版本目录 + 指针切换）/ replace / notify（交给宿主自己处理）</summary>
        [JsonPropertyName("install_strategy")] public string InstallStrategy { get; set; }

        /// <summary>压缩包外层多套了一层目录时，解压后剥掉它。</summary>
        [JsonPropertyName("strip_root_dir")] public bool StripRootDir { get; set; }

        /// <summary>入口可执行文件名，例如 app.exe。</summary>
        [JsonPropertyName("entry")] public string Entry { get; set; }

        /// <summary>安装后命令。不在签名保护范围内，SDK 默认不执行。</summary>
        [JsonPropertyName("post_install")] public string PostInstall { get; set; }
    }

    /// <summary>公告。</summary>
    public class NoticePolicy
    {
        /// <summary>info / warning / critical</summary>
        [JsonPropertyName("level")] public string Level { get; set; }
        [JsonPropertyName("title")] public string Title { get; set; }
        [JsonPropertyName("content")] public string Content { get; set; }
    }

    /// <summary>远程管控策略。</summary>
    public class AppPolicy
    {
        [JsonPropertyName("app_status")] public string AppStatus { get; set; }
        [JsonPropertyName("kill_switch")] public bool KillSwitch { get; set; }
        [JsonPropertyName("kill_message")] public string KillMessage { get; set; }
        [JsonPropertyName("maintenance")] public bool Maintenance { get; set; }
        [JsonPropertyName("maintenance_message")] public string MaintenanceMessage { get; set; }
        [JsonPropertyName("min_version")] public string MinVersion { get; set; }
        [JsonPropertyName("upgrade")] public UpgradePolicy Upgrade { get; set; }
        [JsonPropertyName("notice")] public NoticePolicy Notice { get; set; }
        [JsonPropertyName("policy_ttl_seconds")] public int PolicyTtlSeconds { get; set; }
        [JsonPropertyName("server_time")] public string ServerTime { get; set; }
    }

    /// <summary>激活结果。</summary>
    public class ActivateResult
    {
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("license_id")] public string LicenseId { get; set; }
        [JsonPropertyName("status")] public string Status { get; set; }
        [JsonPropertyName("activated_at")] public string ActivatedAt { get; set; }
        [JsonPropertyName("expires_at")] public string ExpiresAt { get; set; }
        [JsonPropertyName("is_permanent")] public bool IsPermanent { get; set; }
        [JsonPropertyName("device_limit")] public int DeviceLimit { get; set; }
        [JsonPropertyName("device_count")] public int DeviceCount { get; set; }
        [JsonPropertyName("allow_rebind")] public bool AllowRebind { get; set; }
        [JsonPropertyName("rebind_limit")] public int? RebindLimit { get; set; }
        [JsonPropertyName("rebind_remaining")] public int? RebindRemaining { get; set; }
        [JsonPropertyName("offline_grace_hours")] public int OfflineGraceHours { get; set; }
        [JsonPropertyName("license_token")] public string LicenseToken { get; set; }
        [JsonPropertyName("token_expires_at")] public string TokenExpiresAt { get; set; }
        [JsonPropertyName("policy")] public AppPolicy Policy { get; set; }
    }

    /// <summary>验证结果。</summary>
    public class VerifyResult
    {
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("license_id")] public string LicenseId { get; set; }
        [JsonPropertyName("status")] public string Status { get; set; }
        [JsonPropertyName("expires_at")] public string ExpiresAt { get; set; }
        [JsonPropertyName("is_permanent")] public bool IsPermanent { get; set; }
        [JsonPropertyName("offline_grace_hours")] public int OfflineGraceHours { get; set; }
        [JsonPropertyName("license_token")] public string LicenseToken { get; set; }
        [JsonPropertyName("token_expires_at")] public string TokenExpiresAt { get; set; }
        [JsonPropertyName("policy")] public AppPolicy Policy { get; set; }

        /// <summary>为真表示这次是离线宽限期内的本地放行，没有联系服务器。</summary>
        [JsonPropertyName("offline")] public bool Offline { get; set; }
    }

    /// <summary>解绑结果。</summary>
    public class DeactivateResult
    {
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("license_id")] public string LicenseId { get; set; }
        [JsonPropertyName("device_count")] public int DeviceCount { get; set; }
        [JsonPropertyName("device_limit")] public int DeviceLimit { get; set; }
        [JsonPropertyName("rebind_count")] public int RebindCount { get; set; }
        [JsonPropertyName("rebind_remaining")] public int? RebindRemaining { get; set; }
    }

    /// <summary>状态查询结果。</summary>
    public class StatusResult
    {
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("license_id")] public string LicenseId { get; set; }
        [JsonPropertyName("status")] public string Status { get; set; }
        [JsonPropertyName("activated_at")] public string ActivatedAt { get; set; }
        [JsonPropertyName("expires_at")] public string ExpiresAt { get; set; }
        [JsonPropertyName("is_permanent")] public bool IsPermanent { get; set; }
        [JsonPropertyName("device_limit")] public int DeviceLimit { get; set; }
        [JsonPropertyName("device_count")] public int DeviceCount { get; set; }
        [JsonPropertyName("device_bound")] public bool DeviceBound { get; set; }
        [JsonPropertyName("allow_rebind")] public bool AllowRebind { get; set; }
        [JsonPropertyName("rebind_limit")] public int? RebindLimit { get; set; }
        [JsonPropertyName("rebind_count")] public int RebindCount { get; set; }
        [JsonPropertyName("offline_grace_hours")] public int OfflineGraceHours { get; set; }
    }

    internal class PolicyEnvelope
    {
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("policy")] public AppPolicy Policy { get; set; }
    }

    /// <summary>客户端配置。</summary>
    public class LicenseOptions
    {
        /// <summary>应用标识，后台创建应用时确定。</summary>
        public string AppId { get; set; }

        /// <summary>授权中心地址，例如 https://license.example.com</summary>
        public string ServerUrl { get; set; }

        public string PluginId { get; set; }
        public string PluginToken { get; set; }

        /// <summary>
        /// 签名密钥。打包进桌面程序后可被逆向提取，这是客户端授权的固有限制；
        /// 服务端接入请放环境变量，不要下发给终端。
        /// </summary>
        public string PluginSecret { get; set; }

        /// <summary>当前客户端版本，用于版本策略判断。</summary>
        public string ClientVersion { get; set; }

        /// <summary>升级通道，stable 或 beta。</summary>
        public string Channel { get; set; } = "stable";

        /// <summary>覆盖设备指纹。留空则由 SDK 自动生成。</summary>
        public string DeviceId { get; set; }

        /// <summary>设备展示名，便于用户在后台辨认自己的机器。</summary>
        public string DeviceName { get; set; }

        /// <summary>本地状态目录，默认 %LOCALAPPDATA%\JcKami\&lt;AppId&gt;。</summary>
        public string StorageDir { get; set; }

        /// <summary>单次请求超时毫秒数。</summary>
        public int TimeoutMs { get; set; } = 10000;

        /// <summary>可重试错误的最大重试次数。</summary>
        public int MaxRetries { get; set; } = 2;
    }
}
