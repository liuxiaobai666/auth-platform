import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum PluginRuntimeDto { sdk = 'sdk', http = 'http', webhook = 'webhook', service = 'service' }
export enum PluginStatusDto { draft = 'draft', testing = 'testing', active = 'active', disabled = 'disabled' }

export class CreatePluginDto {
  @IsString() @MaxLength(32)
  application_id!: string;

  @IsString() @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]{1,63}$/, { message: 'plugin_id 只能包含小写字母、数字和下划线，且必须以字母开头' })
  plugin_id!: string;

  @IsString() @MaxLength(128)
  name!: string;

  @IsOptional() @IsString() @MaxLength(32)
  version?: string;

  @IsOptional() @IsEnum(PluginRuntimeDto)
  runtime?: PluginRuntimeDto;

  @IsOptional() @IsString() @MaxLength(255)
  endpoint?: string;

  @IsOptional() @IsObject()
  config?: Record<string, unknown>;
}

export class UpdatePluginDto {
  @IsOptional() @IsString() @MaxLength(128)
  name?: string;

  @IsOptional() @IsString() @MaxLength(32)
  version?: string;

  @IsOptional() @IsEnum(PluginRuntimeDto)
  runtime?: PluginRuntimeDto;

  @IsOptional() @IsString() @MaxLength(255)
  endpoint?: string;

  @IsOptional() @IsEnum(PluginStatusDto)
  status?: PluginStatusDto;

  @IsOptional() @IsObject()
  config?: Record<string, unknown>;
}

export class RotateSecretDto {
  /**
   * 旧密钥的保留分钟数。轮换期内新旧密钥都能通过验签，
   * 便于客户端分批更新配置，不会一刀切造成全量失败。
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10080)
  grace_minutes?: number;
}

export class ListPluginDto {
  @IsOptional() @IsString() @MaxLength(32)
  application_id?: string;

  @IsOptional() @IsEnum(PluginStatusDto)
  status?: PluginStatusDto;
}
