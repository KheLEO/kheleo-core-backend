import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BracketRegistrationResponseDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  readonly registrationId!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174001' })
  readonly bracketId!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174002' })
  readonly tournamentId!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174003' })
  readonly athleteId!: string;

  @ApiProperty({ example: 'GOLD' })
  readonly tierName!: string;

  @ApiProperty({
    example: 58.4,
    description: 'Verified GTI score captured at time of registration',
  })
  readonly athleteGti!: number;

  @ApiProperty({ example: 'CONFIRMED' })
  readonly status!: string;

  @ApiProperty({ example: 500.0 })
  readonly feePaid!: number;

  @ApiProperty({ example: '2026-10-11T13:45:00.000Z' })
  readonly registeredAt!: string;

  @ApiPropertyOptional({ example: '123e4567-e89b-12d3-a456-426614174004' })
  readonly teamId?: string | null;
}
