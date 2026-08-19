import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { ToBoolean } from '../../../common/utils/transform';

const VERSION_RE = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.\-]+)?$/;

export class CreateReleaseDto {
  @IsString() @MaxLength(32)
  application_id!: string;

  @IsString() @MaxLength(32)
  @Matches(VERSION_RE, { message: 'version 必须是形如 1.2.3 或 1.2.3-beta.1 的版本号' })
  version!: string;

  @IsOptional() @IsIn(['stable', 'beta'])
  channel?: 'stable' | 'beta';

  @IsOptional() @IsString() @MaxLength(20000)
  release_notes?: string;

  @IsOptional() @ToBoolean() @IsBoolean()
  is_mandatory?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100)
  rollout_percent?: number;

  /** 不上传文件时可以直接登记外部下载地址（自建 CDN、对象存储等） */
  @IsOptional() @IsUrl({ require_tld: false }, { message: 'external_url 必须是合法的 URL' })
  @MaxLength(500)
  external_url?: string;
}

export class UpdateReleaseDto {
  @IsOptional() @IsString() @MaxLength(20000)
  release_notes?: string;

  @IsOptional() @ToBoolean() @IsBoolean()
  is_mandatory?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100)
  rollout_percent?: number;

  @IsOptional() @IsIn(['draft', 'published', 'archived'])
  status?: 'draft' | 'published' | 'archived';

  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(500)
  external_url?: string;
}

export class ListReleaseDto {
  @IsOptional() @IsString() @MaxLength(32)
  application_id?: string;

  @IsOptional() @IsIn(['stable', 'beta'])
  channel?: 'stable' | 'beta';

  @IsOptional() @IsIn(['draft', 'published', 'archived'])
  status?: 'draft' | 'published' | 'archived';
}
