import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { PLAYGROUND_ROUTES } from '../docs.service';

export class InvokeDto {
  @IsString() @MaxLength(64)
  plugin_id!: string;

  @IsIn(Object.keys(PLAYGROUND_ROUTES))
  action!: string;

  @IsOptional() @IsObject()
  body?: Record<string, unknown>;

  @IsOptional() @IsObject()
  query?: Record<string, string>;
}
