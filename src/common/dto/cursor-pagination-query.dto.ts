import { IsOptional, IsInt, Min, Max, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../constants/app.constants';

export class CursorPaginationQueryDto {
  @ApiPropertyOptional({ default: DEFAULT_PAGE_LIMIT, minimum: 1, maximum: MAX_PAGE_LIMIT })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  @Type(() => Number)
  limit: number = DEFAULT_PAGE_LIMIT;

  @ApiPropertyOptional({ description: 'Opaque cursor for next page' })
  @IsOptional()
  @IsString()
  cursor_id?: string;
}
