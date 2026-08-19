import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { ALL_WEBHOOK_EVENTS } from '../webhook-events';

export class CreateEndpointDto {
  @IsString() @MaxLength(32)
  application_id!: string;

  @IsUrl({ require_tld: false }, { message: 'url 必须是合法地址' }) @MaxLength(500)
  url!: string;

  /** 订阅的事件类型，留空表示全部 */
  @IsOptional() @IsArray()
  @IsIn(ALL_WEBHOOK_EVENTS, { each: true })
  events?: string[];
}

export class UpdateEndpointDto {
  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(500)
  url?: string;

  @IsOptional() @IsArray()
  @IsIn(ALL_WEBHOOK_EVENTS, { each: true })
  events?: string[];

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}
