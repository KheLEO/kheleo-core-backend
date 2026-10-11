import { IsOptional, IsString, IsNumber, Min, Max, IsUUID, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class ScoutFeedQueryDto {
  @IsOptional()
  @IsString()
  sport?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_gti?: number;

  @IsOptional()
  @IsUUID()
  cursor_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
