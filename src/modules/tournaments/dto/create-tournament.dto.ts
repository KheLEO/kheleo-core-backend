import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { SportType, TournamentStatus } from '@prisma/client';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';

export class CreateTournamentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @FieldAliases('title')
  readonly name!: string;

  @ApiProperty({ enum: SportType })
  @IsEnum(SportType)
  readonly sport!: SportType;

  @ApiPropertyOptional({ enum: TournamentStatus })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsEnum(TournamentStatus)
  readonly status?: TournamentStatus;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(0)
  @Max(100)
  @FieldAliases('min_gti')
  readonly minGti?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(0)
  @Max(100)
  @FieldAliases('max_gti')
  readonly maxGti?: number;

  @ApiProperty({ minimum: 2 })
  @IsInt()
  @Min(2)
  @FieldAliases('max_teams')
  readonly maxTeams!: number;

  @ApiProperty({ minimum: 1, maximum: 30 })
  @IsInt()
  @Min(1)
  @Max(30)
  @FieldAliases('team_size')
  readonly teamSize!: number;

  @ApiPropertyOptional({ minimum: 0 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(0)
  @FieldAliases('prize_pool')
  readonly prizePool?: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @FieldAliases('venue_name')
  readonly venueName!: string;

  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  @FieldAliases('venue_lat')
  readonly venueLat!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  @FieldAliases('venue_lng')
  readonly venueLng!: number;

  @ApiProperty()
  @IsDateString({ strict: true })
  @FieldAliases('registration_deadline')
  readonly registrationDeadline!: string;

  @ApiProperty()
  @IsDateString({ strict: true })
  @FieldAliases('start_date')
  readonly startDate!: string;

  @ApiProperty()
  @IsDateString({ strict: true })
  @FieldAliases('end_date')
  readonly endDate!: string;
}
