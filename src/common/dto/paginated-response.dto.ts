import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PaginatedResponseDto<T> {
  @ApiProperty({ isArray: true })
  data!: T[];

  @ApiPropertyOptional({
    description: 'Cursor for next page, null if last page',
  })
  next_cursor: string | null = null;

  @ApiProperty()
  has_more!: boolean;

  @ApiProperty()
  count!: number;

  static create<T>(
    data: T[],
    limit: number,
    cursorExtractor?: (item: T) => string,
  ): PaginatedResponseDto<T> {
    const response = new PaginatedResponseDto<T>();
    const hasMore = data.length > limit;
    const trimmed = hasMore ? data.slice(0, limit) : data;

    response.data = trimmed;
    response.has_more = hasMore;
    response.count = trimmed.length;
    response.next_cursor =
      hasMore && cursorExtractor && trimmed.length > 0
        ? cursorExtractor(trimmed[trimmed.length - 1])
        : null;

    return response;
  }
}
