import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';

export enum LicenseStatusDto {
  unused = 'unused', active = 'active', expired = 'expired', banned = 'banned', revoked = 'revoked',
}

export class GenerateLicenseDto {
  @IsString() @MaxLength(32)
  plan_id!: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(5000, { message: '单批最多生成 5000 个卡密' })
  count!: number;

  /** 卡密可读前缀，例如 VIP，最终形如 VIP-XXXXX-XXXXX-... */
  @IsOptional() @IsString() @MaxLength(8)
  @Matches(/^[A-Z0-9]{1,8}$/, { message: '前缀只能是 1-8 位大写字母或数字' })
  prefix?: string;

  /** 分组数，默认 5 组（约 122 位熵） */
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(8)
  groups?: number;

  @IsOptional() @IsString() @MaxLength(255)
  note?: string;

  /** 渠道标记：这批卡卖给哪个发卡网/代理，用于追踪盗版来源 */
  @IsOptional() @IsString() @MaxLength(64)
  channel?: string;

  // ---- 以下字段留空则沿用套餐配置，用于生成"特批卡" ----
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(36500)
  duration_days?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  device_limit?: number;
}

export class ListLicenseDto {
  @IsOptional() @IsString() @MaxLength(32)
  application_id?: string;

  @IsOptional() @IsString() @MaxLength(32)
  plan_id?: string;

  @IsOptional() @IsEnum(LicenseStatusDto)
  status?: LicenseStatusDto;

  @IsOptional() @IsString() @MaxLength(32)
  batch_id?: string;

  /** 按卡密前缀搜索。后台不解密，只匹配 key_prefix 索引列。 */
  @IsOptional() @IsString() @MaxLength(16)
  key_prefix?: string;

  /** 输入完整卡密精确定位（走哈希查找，不泄露其他卡密） */
  @IsOptional() @IsString() @MaxLength(64)
  key?: string;

  @IsOptional() @IsString() @MaxLength(128)
  device_id?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  page_size?: number;
}

export class ExportLicenseDto {
  @IsOptional() @IsString() @MaxLength(32)
  batch_id?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  ids?: string[];

  @IsOptional() @IsString() @MaxLength(32)
  application_id?: string;

  @IsOptional() @IsEnum(LicenseStatusDto)
  status?: LicenseStatusDto;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  limit?: number;
}

export class ReasonDto {
  @IsString() @MaxLength(255)
  reason!: string;
}

export class BatchReasonDto {
  @IsArray() @IsString({ each: true })
  ids!: string[];

  @IsString() @MaxLength(255)
  reason!: string;
}

export class RenewLicenseDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(36500)
  days!: number;

  @IsOptional() @IsString() @MaxLength(255)
  reason?: string;
}

export class UnbindDeviceDto {
  @IsString() @MaxLength(255)
  reason!: string;

  /** 管理员强制解绑默认不占用用户的换绑次数 */
  @IsOptional() @IsBoolean()
  count_as_rebind?: boolean;
}
