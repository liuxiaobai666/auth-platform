import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from './app.exception';
import { ErrorCode, ERROR_MESSAGE } from './error-codes';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req as any).requestId ?? '-';

    let status = 500;
    let code: string = ErrorCode.INTERNAL_ERROR;
    let message = ERROR_MESSAGE[ErrorCode.INTERNAL_ERROR];
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      code = exception.code;
      message = (exception.getResponse() as any).message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      // class-validator 的校验错误会走到这里，统一收敛成 INVALID_REQUEST
      if (status === 400 && body?.message) {
        code = ErrorCode.INVALID_REQUEST;
        message = Array.isArray(body.message) ? body.message.join('; ') : String(body.message);
      } else if (status === 401) {
        code = ErrorCode.UNAUTHORIZED;
        message = ERROR_MESSAGE[ErrorCode.UNAUTHORIZED];
      } else if (status === 403) {
        code = ErrorCode.FORBIDDEN;
        message = ERROR_MESSAGE[ErrorCode.FORBIDDEN];
      } else if (status === 404) {
        code = ErrorCode.NOT_FOUND;
        message = ERROR_MESSAGE[ErrorCode.NOT_FOUND];
      } else {
        code = body?.code ?? ErrorCode.INVALID_REQUEST;
        message = typeof body === 'string' ? body : (body?.message ?? message);
      }
    } else if (
      exception instanceof Error &&
      // body-parser 在请求体超限或 JSON 非法时抛的错，带 status/type，
      // 不该被当成服务端内部错误吞成 500
      (exception as any).type === 'entity.too.large'
    ) {
      status = 413;
      code = ErrorCode.INVALID_REQUEST;
      message = '请求体过大';
    } else if (exception instanceof SyntaxError && 'body' in (exception as any)) {
      status = 400;
      code = ErrorCode.INVALID_REQUEST;
      message = '请求体不是合法的 JSON';
    } else {
      this.logger.error(
        `未捕获异常 [${requestId}] ${req.method} ${req.originalUrl}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    (req as any).errorCode = code;

    const payload: Record<string, unknown> = { code, message, request_id: requestId };
    if (details) payload.details = details;
    res.status(status).json(payload);
  }
}
