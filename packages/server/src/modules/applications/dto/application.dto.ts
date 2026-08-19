import { Type } from 'class-transformer';
import {
  IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { ToBoolean } from '../../../common/utils/transform';

export enum AppTypeDto { windows = 'windows', android = 'android', web = 'web', api = 'api', other = 'other' }
export enum AppStatusDto { active = 'active', disabled = 'disabled' }
export enum NoticeLevelDto { info = 'info', warning = 'warning', critical = 'critical' }

export class CreateApplicationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]{1,63}$/, {
    message: 'app_id 只能包含小写字母、数字和下划线，且必须以字母开头',
  })
  app_id!: string;

  @IsString() @MinLength(1) @MaxLength(128)
  name!: string;

  @IsOptional() @IsEnum(AppTypeDto)
  type?: AppTypeDto;

  @IsOptional() @IsString() @MaxLength(500)
  remark?: string;

  /**
   * 是否顺带创建一副默认接入凭据。默认创建：绝大多数应用只有一个接入端，
   * 建完应用还要再跑一趟插件页才能拿到密钥是纯粹的多余步骤。
   */
  @IsOptional() @ToBoolean() @IsBoolean()
  with_default_plugin?: boolean;
}

export class UpdateApplicationDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  name?: string;

  @IsOptional() @IsEnum(AppTypeDto)
  type?: AppTypeDto;

  @IsOptional() @IsEnum(AppStatusDto)
  status?: AppStatusDto;

  @IsOptional() @IsString() @MaxLength(500)
  remark?: string;
}

/** 远程管控策略。所有字段独立可选，只更新传入的部分。 */
export class UpdatePolicyDto {
  @IsOptional() @IsBoolean()
  kill_switch?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  kill_message?: string;

  @IsOptional() @IsBoolean()
  maintenance?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  maintenance_message?: string;

  @IsOptional() @IsString() @MaxLength(32)
  min_version?: string;

  @IsOptional() @IsString() @MaxLength(32)
  latest_version?: string;

  @IsOptional() @IsBoolean()
  force_upgrade?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  upgrade_message?: string;

  @IsOptional() @IsBoolean()
  notice_enabled?: boolean;

  @IsOptional() @IsEnum(NoticeLevelDto)
  notice_level?: NoticeLevelDto;

  @IsOptional() @IsString() @MaxLength(128)
  notice_title?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  notice_content?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(86400)
  policy_ttl_seconds?: number;
}

export class ListApplicationDto {
  @IsOptional() @IsString() @MaxLength(64)
  keyword?: string;

  @IsOptional() @IsEnum(AppStatusDto)
  status?: AppStatusDto;

  @IsOptional() @IsEnum(AppTypeDto)
  type?: AppTypeDto;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  page_size?: number;
}
