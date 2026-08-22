import { IsBoolean, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { ToBoolean } from '../../../common/utils/transform';

export class UpdateDistSiteDto {
  /** 对外链接名，决定 /d/<slug>。留空沿用 app_id。 */
  @IsOptional() @IsString() @MaxLength(64)
  slug?: string;

  @IsOptional() @ToBoolean() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsString() @MaxLength(128)
  title?: string;

  @IsOptional() @IsString() @MaxLength(255)
  tagline?: string;

  @IsOptional() @IsUrl({ require_tld: false }, { message: 'logo_url 必须是合法的 URL' })
  @MaxLength(500)
  logo_url?: string;

  /** 使用说明，支持极简 markdown（标题、列表、粗体、行内代码） */
  @IsOptional() @IsString() @MaxLength(20000)
  intro?: string;

  @IsOptional() @IsUrl({ require_tld: false }, { message: 'purchase_url 必须是合法的 URL' })
  @MaxLength(500)
  purchase_url?: string;

  @IsOptional() @IsString() @MaxLength(64)
  support_qq?: string;

  @IsOptional() @IsString() @MaxLength(64)
  support_wechat?: string;

  @IsOptional() @IsString() @MaxLength(128)
  support_email?: string;

  @IsOptional() @ToBoolean() @IsBoolean()
  require_license?: boolean;

  @IsOptional() @ToBoolean() @IsBoolean()
  show_changelog?: boolean;
}

export class UnlockDto {
  @IsOptional() @IsString() @MaxLength(128)
  license_key?: string;
}
