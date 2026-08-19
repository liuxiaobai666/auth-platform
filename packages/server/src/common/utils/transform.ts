import { Transform } from 'class-transformer';

/**
 * 布尔值转换。
 *
 * 不能用 @Type(() => Boolean)：multipart 表单和查询串里的布尔值是字符串，
 * 而 Boolean("false") === true，会把「关闭」悄悄变成「开启」。
 * 这里只认可识别的真值与假值，其余原样透传交给 @IsBoolean 报错。
 */
export const ToBoolean = () =>
  Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'off', ''].includes(v)) return false;
    }
    return value;
  });
