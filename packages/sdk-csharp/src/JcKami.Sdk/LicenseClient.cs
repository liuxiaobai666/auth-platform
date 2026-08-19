using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace JcKami
{
    /// <summary>
    /// 卡密平台客户端。
    ///
    /// <code>
    /// var client = new LicenseClient(new LicenseOptions
    /// {
    ///     AppId = "my_tool",
    ///     ServerUrl = "https://license.example.com",
    ///     PluginId = "my_tool_default",
    ///     PluginToken = "pk_...",
    ///     PluginSecret = "sk_...",
    ///     ClientVersion = "1.0.0",
    /// });
    ///
    /// await client.ActivateAsync(userInputKey);   // 首次激活
    /// var result = await client.VerifyAsync();    // 每次启动校验
    /// </code>
    /// </summary>
    public class LicenseClient : IDisposable
    {
        private static readonly JsonSerializerOptions JsonOpts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        private readonly LicenseOptions _opts;
        private readonly SecureStorage _storage;
        private readonly HttpClient _http;
        private readonly bool _ownsHttp;

        /// <summary>本机设备指纹。</summary>
        public string DeviceId { get; }

        /// <summary>每次拿到策略时触发，用于展示公告与处理升级。</summary>
        public event Action<AppPolicy> PolicyReceived;

        public LicenseClient(LicenseOptions options, HttpClient httpClient = null)
        {
            if (options == null) throw new ArgumentNullException(nameof(options));
            Require(options.AppId, nameof(options.AppId));
            Require(options.ServerUrl, nameof(options.ServerUrl));
            Require(options.PluginId, nameof(options.PluginId));
            Require(options.PluginToken, nameof(options.PluginToken));
            Require(options.PluginSecret, nameof(options.PluginSecret));

            _opts = options;
            _opts.ServerUrl = options.ServerUrl.TrimEnd('/');

            var baseDir = string.IsNullOrEmpty(options.StorageDir)
                ? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "JcKami", options.AppId)
                : options.StorageDir;

            DeviceId = string.IsNullOrEmpty(options.DeviceId)
                ? DeviceIdentity.Resolve(Path.Combine(baseDir, "device.salt"))
                : options.DeviceId;

            _storage = new SecureStorage(Path.Combine(baseDir, "license.dat"), DeviceId);

            // 允许外部注入 HttpClient：宿主程序通常已有统一的连接池与代理配置
            _ownsHttp = httpClient == null;
            _http = httpClient ?? new HttpClient();
            _http.Timeout = TimeSpan.FromMilliseconds(Math.Max(options.TimeoutMs, 1000));
        }

        private static void Require(string value, string name)
        {
            if (string.IsNullOrWhiteSpace(value))
                throw new ArgumentException($"LicenseOptions.{name} 不能为空", name);
        }

        // ============================================================ 对外接口

        /// <summary>首次激活。成功后凭据加密保存到本地。</summary>
        public async Task<ActivateResult> ActivateAsync(
            string licenseKey, string idempotencyKey = null, CancellationToken ct = default)
        {
            var body = new Dictionary<string, object>
            {
                ["app_id"] = _opts.AppId,
                ["license_key"] = (licenseKey ?? "").Trim(),
                ["device_id"] = DeviceId,
                ["device_name"] = _opts.DeviceName ?? SafeMachineName(),
                ["client_version"] = _opts.ClientVersion,
                ["channel"] = _opts.Channel,
            };

            var result = await RequestAsync<ActivateResult>(
                HttpMethod.Post, "/api/v1/license/activate", body, idempotencyKey, ct)
                .ConfigureAwait(false);

            Persist(result.LicenseId, result.LicenseToken, result.TokenExpiresAt,
                    result.ExpiresAt, result.OfflineGraceHours);
            PolicyReceived?.Invoke(result.Policy);
            return result;
        }

        /// <summary>
        /// 启动校验，最常调用的方法。
        ///
        /// 正常路径走在线验证；网络不通时，若距上次成功验证未超过服务端下发的离线宽限期，
        /// 则本地放行并把 <see cref="VerifyResult.Offline"/> 置为 true。
        /// 超过宽限期一律拒绝 —— 不会因为「可能只是网络问题」而放行。
        /// </summary>
        public async Task<VerifyResult> VerifyAsync(CancellationToken ct = default)
        {
            var state = _storage.Read();
            if (state == null)
                throw new LicenseException(ErrorCode.NotActivatedLocally, "尚未激活，请先输入卡密激活");

            VerifyResult result;
            try
            {
                var body = new Dictionary<string, object>
                {
                    ["app_id"] = _opts.AppId,
                    ["license_token"] = state.LicenseToken,
                    ["device_id"] = DeviceId,
                    ["client_version"] = _opts.ClientVersion,
                    ["channel"] = _opts.Channel,
                };
                result = await RequestAsync<VerifyResult>(
                    HttpMethod.Post, "/api/v1/license/verify", body, null, ct).ConfigureAwait(false);
            }
            catch (LicenseException ex) when (ex.Code == ErrorCode.NetworkUnavailable)
            {
                // 只有网络层失败才考虑宽限期。服务端明确拒绝（封禁、过期、关停）一律照办。
                return FallbackOffline(state);
            }

            Persist(state.LicenseId, result.LicenseToken, result.TokenExpiresAt,
                    result.ExpiresAt, result.OfflineGraceHours);
            PolicyReceived?.Invoke(result.Policy);
            return result;
        }

        /// <summary>主动解绑本机，也就是「换绑」。会消耗一次换绑配额。</summary>
        public async Task<DeactivateResult> DeactivateAsync(
            string reason = null, string idempotencyKey = null, CancellationToken ct = default)
        {
            var state = _storage.Read();
            if (state == null)
                throw new LicenseException(ErrorCode.NotActivatedLocally, "本机尚未激活");

            var body = new Dictionary<string, object>
            {
                ["app_id"] = _opts.AppId,
                ["license_token"] = state.LicenseToken,
                ["device_id"] = DeviceId,
                ["reason"] = reason,
            };

            var result = await RequestAsync<DeactivateResult>(
                HttpMethod.Post, "/api/v1/license/deactivate", body, idempotencyKey, ct)
                .ConfigureAwait(false);

            _storage.Clear();
            return result;
        }

        /// <summary>查询授权状态。只读，不签发令牌，也不影响本地状态。</summary>
        public Task<StatusResult> StatusAsync(string licenseKey = null, CancellationToken ct = default)
        {
            var query = new Dictionary<string, string>
            {
                ["app_id"] = _opts.AppId,
                ["device_id"] = DeviceId,
            };

            if (!string.IsNullOrEmpty(licenseKey))
            {
                query["license_key"] = licenseKey.Trim();
            }
            else
            {
                var state = _storage.Read();
                if (state == null)
                    throw new LicenseException(ErrorCode.NotActivatedLocally, "需要提供卡密或先完成激活");
                query["license_id"] = state.LicenseId;
            }

            return RequestAsync<StatusResult>(
                HttpMethod.Get, "/api/v1/license/status" + BuildQuery(query), null, null, ct);
        }

        /// <summary>拉取远程管控策略。未激活时也能调用。</summary>
        public async Task<AppPolicy> FetchPolicyAsync(CancellationToken ct = default)
        {
            var query = new Dictionary<string, string>
            {
                ["app_id"] = _opts.AppId,
                ["device_id"] = DeviceId,
                ["client_version"] = _opts.ClientVersion,
                ["channel"] = _opts.Channel,
            };

            var env = await RequestAsync<PolicyEnvelope>(
                HttpMethod.Get, "/api/v1/license/policy" + BuildQuery(query), null, null, ct)
                .ConfigureAwait(false);

            PolicyReceived?.Invoke(env.Policy);
            return env.Policy;
        }

        /// <summary>本地是否存有激活凭据。只是个快速判断，不代表授权仍然有效。</summary>
        public bool HasLocalLicense()
        {
            try { return _storage.Read() != null; }
            catch (LicenseException) { return false; }
        }

        /// <summary>清除本地凭据，不通知服务端。</summary>
        public void ClearLocal() => _storage.Clear();

        public void Dispose()
        {
            if (_ownsHttp) _http?.Dispose();
        }

        // ============================================================ 内部

        private VerifyResult FallbackOffline(LicenseState state)
        {
            if (state.OfflineGraceHours <= 0)
                throw new LicenseException(
                    ErrorCode.NetworkUnavailable, "当前授权要求必须联网验证，请检查网络连接");

            var elapsed = DateTimeOffset.UtcNow - ParseIso(state.LastVerifiedAt);
            if (elapsed.TotalHours > state.OfflineGraceHours || elapsed.TotalSeconds < 0)
                throw new LicenseException(
                    ErrorCode.NetworkUnavailable,
                    $"已离线 {Math.Round(elapsed.TotalHours)} 小时，超过 {state.OfflineGraceHours} 小时宽限期，请联网后重试");

            // 宽限期不能给已到期的授权续命
            if (!string.IsNullOrEmpty(state.ExpiresAt) && ParseIso(state.ExpiresAt) <= DateTimeOffset.UtcNow)
                throw new LicenseException(ErrorCode.LicenseExpired, "授权已到期");

            return new VerifyResult
            {
                Success = true,
                Offline = true,
                LicenseId = state.LicenseId,
                Status = "active",
                ExpiresAt = state.ExpiresAt,
                IsPermanent = string.IsNullOrEmpty(state.ExpiresAt),
                OfflineGraceHours = state.OfflineGraceHours,
                LicenseToken = state.LicenseToken,
                TokenExpiresAt = state.TokenExpiresAt,
                Policy = null,
            };
        }

        private void Persist(string licenseId, string token, string tokenExpiresAt,
                             string expiresAt, int graceHours)
        {
            _storage.Write(new LicenseState
            {
                LicenseId = licenseId,
                LicenseToken = token,
                TokenExpiresAt = tokenExpiresAt,
                ExpiresAt = expiresAt,
                OfflineGraceHours = graceHours,
                LastVerifiedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                DeviceId = DeviceId,
                AppId = _opts.AppId,
            });
        }

        /// <summary>按 DEVELOPMENT.md 8.7 组装签名。</summary>
        private Dictionary<string, string> SignHeaders(string method, string urlPath, string body)
        {
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                .ToString(CultureInfo.InvariantCulture);
            var nonce = Guid.NewGuid().ToString();

            string bodyHash;
            using (var sha = SHA256.Create())
                bodyHash = DeviceIdentity.ToHex(sha.ComputeHash(Encoding.UTF8.GetBytes(body ?? "")));

            var payload = string.Join("\n", new[]
            {
                method.ToUpperInvariant(), urlPath, timestamp, nonce, bodyHash,
            });

            string signature;
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_opts.PluginSecret)))
                signature = DeviceIdentity.ToHex(hmac.ComputeHash(Encoding.UTF8.GetBytes(payload)));

            return new Dictionary<string, string>
            {
                ["X-Plugin-Id"] = _opts.PluginId,
                ["X-Timestamp"] = timestamp,
                ["X-Nonce"] = nonce,
                ["X-Signature"] = signature,
            };
        }

        /// <summary>
        /// 拼查询串。签名算的就是这个字符串，所以必须在这里拼一次、请求也用它，
        /// 不能签名一份、发送另一份。
        /// </summary>
        private static string BuildQuery(Dictionary<string, string> query)
        {
            var parts = query
                .Where(kv => !string.IsNullOrEmpty(kv.Value))
                .Select(kv => Uri.EscapeDataString(kv.Key) + "=" + Uri.EscapeDataString(kv.Value))
                .ToArray();
            return parts.Length == 0 ? "" : "?" + string.Join("&", parts);
        }

        private async Task<T> RequestAsync<T>(
            HttpMethod method, string urlPath, Dictionary<string, object> body,
            string idempotencyKey, CancellationToken ct)
        {
            var payload = body == null
                ? ""
                : JsonSerializer.Serialize(
                    body.Where(kv => kv.Value != null).ToDictionary(kv => kv.Key, kv => kv.Value));

            LicenseException lastError = null;

            for (var attempt = 0; attempt <= _opts.MaxRetries; attempt++)
            {
                // 每次重试都重新签名：时间戳和 nonce 必须是新的，否则会被判定重放
                using (var request = new HttpRequestMessage(method, _opts.ServerUrl + urlPath))
                {
                    request.Headers.TryAddWithoutValidation(
                        "Authorization", "Bearer " + _opts.PluginToken);
                    foreach (var kv in SignHeaders(method.Method, urlPath, payload))
                        request.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                    if (!string.IsNullOrEmpty(idempotencyKey))
                        request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);

                    if (payload.Length > 0)
                        request.Content = new StringContent(payload, Encoding.UTF8, "application/json");

                    LicenseException error;
                    try
                    {
                        using (var response = await _http.SendAsync(request, ct).ConfigureAwait(false))
                        {
                            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);

                            if (response.IsSuccessStatusCode)
                                return JsonSerializer.Deserialize<T>(
                                    string.IsNullOrEmpty(text) ? "{}" : text, JsonOpts);

                            error = ParseError(text, (int)response.StatusCode);
                        }
                    }
                    catch (LicenseException) { throw; }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                    catch (Exception ex)
                    {
                        // 连接失败、DNS 解析不了、超时，统一归为网络不可用，交给离线宽限期处理
                        error = new LicenseException(
                            ErrorCode.NetworkUnavailable, "无法连接授权服务器: " + ex.Message);
                    }

                    if (!error.IsRetryable || attempt == _opts.MaxRetries) throw error;
                    lastError = error;
                    await BackoffAsync(attempt, error, ct).ConfigureAwait(false);
                }
            }

            throw lastError ?? new LicenseException(ErrorCode.InternalError, "请求失败");
        }

        private static LicenseException ParseError(string text, int status)
        {
            string code = ErrorCode.InternalError;
            string message = $"请求失败（HTTP {status}）";
            string requestId = null;
            var details = new Dictionary<string, object>();

            try
            {
                using (var doc = JsonDocument.Parse(string.IsNullOrEmpty(text) ? "{}" : text))
                {
                    var root = doc.RootElement;
                    if (root.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String)
                        code = c.GetString();
                    if (root.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String)
                        message = m.GetString();
                    if (root.TryGetProperty("request_id", out var r) && r.ValueKind == JsonValueKind.String)
                        requestId = r.GetString();
                    if (root.TryGetProperty("details", out var d) && d.ValueKind == JsonValueKind.Object)
                        foreach (var p in d.EnumerateObject())
                            details[p.Name] = p.Value.ValueKind == JsonValueKind.Number
                                ? (object)p.Value.GetDouble()
                                : p.Value.ToString();
                }
            }
            catch
            {
                // 响应体不是合法 JSON，保留上面的默认值
            }

            return new LicenseException(code, message, status, requestId, details);
        }

        private static Task BackoffAsync(int attempt, LicenseException error, CancellationToken ct)
        {
            // 限流错误优先听服务端的 retry_after，其余用指数退避
            double seconds = 0.5 * Math.Pow(2, attempt);
            if (error.Details != null && error.Details.TryGetValue("retry_after", out var raw)
                && double.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture),
                    NumberStyles.Any, CultureInfo.InvariantCulture, out var retryAfter))
            {
                seconds = Math.Min(retryAfter, 30);
            }
            return Task.Delay(TimeSpan.FromSeconds(seconds), ct);
        }

        private static DateTimeOffset ParseIso(string value)
        {
            return DateTimeOffset.Parse(
                value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
        }

        private static string SafeMachineName()
        {
            try { return Environment.MachineName; }
            catch { return "unknown"; }
        }
    }
}
