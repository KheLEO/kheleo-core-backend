import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { SportType } from '@prisma/client';
export class ScoutAlertsQueryDto {
  @IsOptional() @IsEnum(SportType) sport?: SportType;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @IsUUID() cursor_id?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}
