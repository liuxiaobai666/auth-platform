import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class ReserveDto {
  @IsString({ message: 'app_id 不能为空' }) @MaxLength(64)
  app_id!: string;

  @IsString({ message: 'license_token 不能为空' }) @MaxLength(2048)
  license_token!: string;

  @IsString({ message: 'device_id 不能为空' })
  @MinLength(8, { message: 'device_id 至少 8 个字符' }) @MaxLength(128)
  device_id!: string;

  /** 本次要消费几次，默认 1 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000)
  amount?: number;

  /** 幂等键：超时重试用同一个值，服务端不会重复冻结 */
  @IsOptional() @IsString() @MaxLength(128)
  request_id?: string;

  /** 预扣存活秒数，超时未确认自动释放，默认 300、最大 3600 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(3600)
  ttl_seconds?: number;
}

export class ConfirmDto {
  @IsString() @MaxLength(64)
  app_id!: string;

  @IsString() @MaxLength(64)
  reservation_id!: string;
}

export class ReleaseDto {
  @IsString() @MaxLength(64)
  app_id!: string;

  @IsString() @MaxLength(64)
  reservation_id!: string;
}
