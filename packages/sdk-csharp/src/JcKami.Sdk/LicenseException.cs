using System;
using System.Collections.Generic;

namespace JcKami
{
    /// <summary>
    /// 授权相关异常。业务分支请用 <see cref="Code"/> 判断，不要匹配 <see cref="Exception.Message"/>。
    /// </summary>
    public class LicenseException : Exception
    {
        /// <summary>标准错误码，例如 LICENSE_EXPIRED。</summary>
        public string Code { get; }

        /// <summary>HTTP 状态码。本地产生的错误为 0。</summary>
        public int HttpStatus { get; }

        /// <summary>服务端请求 ID。向服务方报障时提供它能直接定位到日志。</summary>
        public string RequestId { get; }

        /// <summary>附加信息，例如限流时的 retry_after、设备超限时的 device_limit。</summary>
        public IReadOnlyDictionary<string, object> Details { get; }

        /// <summary>该错误是否值得重试。</summary>
        public bool IsRetryable => ErrorCode.Retryable.Contains(Code);

        public LicenseException(
            string code,
            string message,
            int httpStatus = 0,
            string requestId = null,
            IReadOnlyDictionary<string, object> details = null)
            : base(message)
        {
            Code = code;
            HttpStatus = httpStatus;
            RequestId = requestId;
            Details = details ?? new Dictionary<string, object>();
        }

        public override string ToString() => $"[{Code}] {Message}";
    }
}
