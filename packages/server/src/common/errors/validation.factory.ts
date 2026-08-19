import { ValidationError } from '@nestjs/common';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

/** 存在性类约束优先：字段没传时应该说「不能为空」，而不是「长度超限」。 */
const PRESENCE_CONSTRAINTS = ['isDefined', 'isNotEmpty', 'isString', 'isNumber', 'isBoolean', 'isArray'];

function pickMessage(error: ValidationError): string {
  const constraints = error.constraints ?? {};
  for (const key of PRESENCE_CONSTRAINTS) {
    if (constraints[key]) return constraints[key];
  }
  const values = Object.values(constraints);
  return values[0] ?? `${error.property} 不合法`;
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.children?.length) return flatten(e.children, path);
    return [pickMessage(e)];
  });
}

/**
 * 把 class-validator 的错误收敛成一条 INVALID_REQUEST。
 * 每个字段只取一条最有意义的提示，避免同一字段冒出三四条重复信息。
 */
export function validationExceptionFactory(errors: ValidationError[]) {
  return new AppException(ErrorCode.INVALID_REQUEST, flatten(errors).join('; '));
}
