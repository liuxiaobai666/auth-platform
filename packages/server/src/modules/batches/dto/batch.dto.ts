import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListBatchDto {
  @IsOptional() @IsString() @MaxLength(32)
  application_id?: string;

  @IsOptional() @IsString() @MaxLength(64)
  channel?: string;

  @IsOptional() @IsString() @MaxLength(64)
  keyword?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  page_size?: number;
}

export class UpdateBatchDto {
  @IsOptional() @IsString() @MaxLength(64)
  channel?: string;

  @IsOptional() @IsString() @MaxLength(255)
  note?: string;
}

export class RevokeBatchDto {
  @IsString() @MaxLength(255)
  reason!: string;
}
