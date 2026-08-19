import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS, ERROR_MESSAGE, ErrorCode, ErrorCodeValue } from './error-codes';

/**
 * 全站统一业务异常。响应体固定为 { code, message, request_id }，
 * 额外信息放在 details 里，不影响客户端按 code 判断。
 */
export class AppException extends HttpException {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCodeValue | string, message?: string, details?: Record<string, unknown>) {
    const status = ERROR_HTTP_STATUS[code] ?? 400;
    super({ code, message: message ?? ERROR_MESSAGE[code] ?? '请求处理失败' }, status);
    this.code = code;
    this.details = details;
  }

  static invalid(message?: string, details?: Record<string, unknown>) {
    return new AppException(ErrorCode.INVALID_REQUEST, message, details);
  }

  static notFound(message?: string) {
    return new AppException(ErrorCode.NOT_FOUND, message);
  }

  static denied(message?: string) {
    return new AppException(ErrorCode.PERMISSION_DENIED, message);
  }
}
