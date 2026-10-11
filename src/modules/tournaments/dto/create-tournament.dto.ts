import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { SportType } from '@prisma/client';

export class CreateTournamentDto {
  @ApiProperty({ example: 'Varanasi Premier Grassroots Cup' })
  @IsString()
  @IsNotEmpty()
  readonly name!: string;

  @ApiProperty({ enum: SportType, example: SportType.CRICKET })
  @IsEnum(SportType)
  @IsNotEmpty()
  readonly sport!: SportType;

  @ApiPropertyOptional({ example: 0.0 })
  @IsOptional()
  @IsNumber()
  readonly minGti?: number;

  @ApiPropertyOptional({ example: 100.0 })
  @IsOptional()
  @IsNumber()
  readonly maxGti?: number;

  @ApiProperty({ example: 16 })
  @IsInt()
  @Min(2)
  readonly maxTeams!: number;

  @ApiProperty({ example: 11 })
  @IsInt()
  @Min(1)
  readonly teamSize!: number;

  @ApiPropertyOptional({ example: 25000.0 })
  @IsOptional()
  @IsNumber()
  readonly prizePool?: number;

  @ApiProperty({ example: 'Sigra Stadium, Varanasi' })
  @IsString()
  @IsNotEmpty()
  readonly venueName!: string;

  @ApiProperty({ example: 25.3176 })
  @IsLatitude()
  readonly venueLat!: number;

  @ApiProperty({ example: 82.9739 })
  @IsLongitude()
  readonly venueLng!: number;

  @ApiProperty({ example: '2026-10-25T18:00:00.000Z' })
  @IsString()
  @IsNotEmpty()
  readonly registrationDeadline!: string;

  @ApiProperty({ example: '2026-11-01T09:00:00.000Z' })
  @IsString()
  @IsNotEmpty()
  readonly startDate!: string;

  @ApiProperty({ example: '2026-11-05T18:00:00.000Z' })
  @IsString()
  @IsNotEmpty()
  readonly endDate!: string;
}
