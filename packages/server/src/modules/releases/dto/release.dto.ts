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

  // ---- 更新包元数据：客户端 SDK 据此决定怎么安装 ----

  /** zip=通用压缩包，onefile/onedir=PyInstaller 两种打包形态 */
  @IsOptional() @IsIn(['zip', 'onefile', 'onedir'])
  package_type?: 'zip' | 'onefile' | 'onedir';

  /** versioned=版本目录切换（可回滚，推荐），replace=原地覆盖，notify=只通知不代装 */
  @IsOptional() @IsIn(['versioned', 'replace', 'notify'])
  install_strategy?: 'versioned' | 'replace' | 'notify';

  /** 压缩包里多套了一层目录（dist/YourApp/）时置真，解压时剥掉 */
  @IsOptional() @ToBoolean() @IsBoolean()
  strip_root_dir?: boolean;

  /** 新版入口文件名，如 app.exe / main.js / index.php */
  @IsOptional() @IsString() @MaxLength(255)
  entry?: string;

  /** 安装后执行的命令，如 pip install -r requirements.txt */
  @IsOptional() @IsString() @MaxLength(500)
  post_install?: string;
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

  @IsOptional() @IsIn(['zip', 'onefile', 'onedir'])
  package_type?: 'zip' | 'onefile' | 'onedir';

  @IsOptional() @IsIn(['versioned', 'replace', 'notify'])
  install_strategy?: 'versioned' | 'replace' | 'notify';

  @IsOptional() @ToBoolean() @IsBoolean()
  strip_root_dir?: boolean;

  @IsOptional() @IsString() @MaxLength(255)
  entry?: string;

  @IsOptional() @IsString() @MaxLength(500)
  post_install?: string;
}

export class ListReleaseDto {
  @IsOptional() @IsString() @MaxLength(32)
  application_id?: string;

  @IsOptional() @IsIn(['stable', 'beta'])
  channel?: 'stable' | 'beta';

  @IsOptional() @IsIn(['draft', 'published', 'archived'])
  status?: 'draft' | 'published' | 'archived';
}
