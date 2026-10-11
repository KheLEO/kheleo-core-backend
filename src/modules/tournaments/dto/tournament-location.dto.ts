import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TournamentLocationDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  readonly id!: string;

  @ApiProperty({ example: 'Varanasi Premier Grassroots Cup' })
  readonly name!: string;

  @ApiProperty({ example: 'CRICKET' })
  readonly sport!: string;

  @ApiProperty({ example: 'REGISTRATION_OPEN' })
  readonly status!: string;

  @ApiProperty({ example: 25.0 })
  readonly minGti!: number;

  @ApiProperty({ example: 60.0 })
  readonly maxGti!: number;

  @ApiProperty({ example: 'Sigra Stadium, Varanasi' })
  readonly venueName!: string;

  @ApiProperty({ example: 25.3176 })
  readonly venueLat!: number;

  @ApiProperty({ example: 82.9739 })
  readonly venueLng!: number;

  @ApiProperty({
    example: 12.4,
    description: 'Distance in kilometers from searching GPS coordinates',
  })
  readonly distanceKm!: number;

  @ApiProperty({ example: '2026-11-01T09:00:00.000Z' })
  readonly startDate!: string;

  @ApiProperty({ example: '2026-10-25T18:00:00.000Z' })
  readonly registrationDeadline!: string;

  @ApiPropertyOptional({ example: 50000.0 })
  readonly prizePool?: number;

  @ApiPropertyOptional({ example: 16 })
  readonly maxTeams?: number;

  @ApiPropertyOptional({ example: 11 })
  readonly teamSize?: number;
}
