import { IsOptional, IsString, IsNumber, Min } from 'class-validator';
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
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}
