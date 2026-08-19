using System.Text.Json.Serialization;

namespace JcKami
{
    /// <summary>本地保存的授权状态。</summary>
    public class LicenseState
    {
        [JsonPropertyName("license_id")]
        public string LicenseId { get; set; }

        [JsonPropertyName("license_token")]
        public string LicenseToken { get; set; }

        [JsonPropertyName("token_expires_at")]
        public string TokenExpiresAt { get; set; }

        [JsonPropertyName("expires_at")]
        public string ExpiresAt { get; set; }

        [JsonPropertyName("offline_grace_hours")]
        public int OfflineGraceHours { get; set; }

        /// <summary>上一次在线验证成功的时间，离线宽限期从这里开始算。</summary>
        [JsonPropertyName("last_verified_at")]
        public string LastVerifiedAt { get; set; }

        [JsonPropertyName("device_id")]
        public string DeviceId { get; set; }

        [JsonPropertyName("app_id")]
        public string AppId { get; set; }
    }
}
