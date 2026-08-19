import { Type } from 'class-transformer';
import {
  IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';

export enum PlanStatusDto { active = 'active', inactive = 'inactive' }

export class CreatePlanDto {
  @IsString() @MaxLength(32)
  application_id!: string;

  @IsString() @MaxLength(64)
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]{1,63}$/, { message: 'code 只能包含字母、数字和下划线，且必须以字母开头' })
  code!: string;

  @IsString() @MaxLength(128)
  name!: string;

  /** 不传或传 null 表示永久卡 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(36500)
  duration_days?: number | null;

  @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  device_limit!: number;

  @IsOptional() @IsBoolean()
  allow_rebind?: boolean;

  /** 不传表示不限次数；allow_rebind 为 false 时忽略 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000)
  rebind_limit?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  price?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8760)
  offline_grace_hours?: number;

  @IsOptional() @IsEnum(PlanStatusDto)
  status?: PlanStatusDto;

  @IsOptional() @Type(() => Number) @IsInt()
  sort_order?: number;
}

export class UpdatePlanDto {
  @IsOptional() @IsString() @MaxLength(128)
  name?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(36500)
  duration_days?: number | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  device_limit?: number;

  @IsOptional() @IsBoolean()
  allow_rebind?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000)
  rebind_limit?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  price?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8760)
  offline_grace_hours?: number;

  @IsOptional() @IsEnum(PlanStatusDto)
  status?: PlanStatusDto;

  @IsOptional() @Type(() => Number) @IsInt()
  sort_order?: number;
}

export class ListPlanDto {
  @IsOptional() @IsString() @MaxLength(32)
  application_id?: string;

  @IsOptional() @IsEnum(PlanStatusDto)
  status?: PlanStatusDto;
}
