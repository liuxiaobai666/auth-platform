import { IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export enum ChannelDto { stable = 'stable', beta = 'beta' }

export class ActivateDto {
  @IsString({ message: 'app_id 不能为空' }) @MaxLength(64)
  app_id!: string;

  @IsString({ message: 'license_key 不能为空' })
  @MinLength(8, { message: 'license_key 长度不足' })
  @MaxLength(64, { message: 'license_key 过长' })
  license_key!: string;

  /** 稳定设备指纹，由 SDK 生成。服务端只存不解析。 */
  @IsString({ message: 'device_id 不能为空' })
  @MinLength(8, { message: 'device_id 至少 8 个字符' })
  @MaxLength(128, { message: 'device_id 不能超过 128 个字符' })
  device_id!: string;

  @IsOptional() @IsString() @MaxLength(128)
  device_name?: string;

  @IsOptional() @IsString() @MaxLength(32)
  client_version?: string;

  @IsOptional() @IsEnum(ChannelDto)
  channel?: ChannelDto;
}

export class VerifyDto {
  @IsString({ message: 'app_id 不能为空' }) @MaxLength(64)
  app_id!: string;

  @IsString({ message: 'license_token 不能为空' }) @MaxLength(2048)
  license_token!: string;

  @IsString({ message: 'device_id 不能为空' })
  @MinLength(8, { message: 'device_id 至少 8 个字符' })
  @MaxLength(128, { message: 'device_id 不能超过 128 个字符' })
  device_id!: string;

  @IsOptional() @IsString() @MaxLength(32)
  client_version?: string;

  @IsOptional() @IsEnum(ChannelDto)
  channel?: ChannelDto;
}

export class DeactivateDto {
  @IsString({ message: 'app_id 不能为空' }) @MaxLength(64)
  app_id!: string;

  @IsOptional() @IsString() @MaxLength(2048)
  license_token?: string;

  @IsOptional() @IsString() @MinLength(8) @MaxLength(64)
  license_key?: string;

  @IsString({ message: 'device_id 不能为空' })
  @MinLength(8, { message: 'device_id 至少 8 个字符' })
  @MaxLength(128, { message: 'device_id 不能超过 128 个字符' })
  device_id!: string;

  @IsOptional() @IsString() @MaxLength(255)
  reason?: string;
}

export class StatusQueryDto {
  @IsString({ message: 'app_id 不能为空' }) @MaxLength(64)
  app_id!: string;

  @IsOptional() @IsString() @MaxLength(32)
  license_id?: string;

  @IsOptional() @IsString() @MaxLength(64)
  license_key?: string;

  @IsOptional() @IsString() @MaxLength(128)
  device_id?: string;
}

export class PolicyQueryDto {
  @IsString({ message: 'app_id 不能为空' }) @MaxLength(64)
  app_id!: string;

  @IsOptional() @IsString() @MaxLength(32)
  client_version?: string;

  @IsOptional() @IsString() @MaxLength(128)
  device_id?: string;

  @IsOptional() @IsIn(['stable', 'beta'])
  channel?: 'stable' | 'beta';
}
