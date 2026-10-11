import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';

export function ApiCursorQuery(): MethodDecorator {
  return applyDecorators(
    ApiQuery({ name: 'limit', required: false, type: Number, example: 20 }),
    ApiQuery({ name: 'cursor_id', required: false, type: String }),
  );
}
