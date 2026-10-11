import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class Rfc7807ProblemDetailsDto {
  @ApiProperty({ example: 'https://api.kheleo.com/errors/http-400' })
  type!: string;

  @ApiProperty({ example: 'Bad Request' })
  title!: string;

  @ApiProperty({ example: 400 })
  status!: number;

  @ApiProperty({ example: 'Validation failed for one or more fields.' })
  detail!: string;

  @ApiProperty({ example: '/api/v1/auth/otp/request' })
  instance!: string;

  @ApiPropertyOptional()
  invalidParams?: ReadonlyArray<{ name: string; reason: string }>;

  @ApiProperty({ example: '2026-10-11T12:00:00.000Z' })
  timestamp!: string;
}
