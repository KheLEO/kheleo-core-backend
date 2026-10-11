import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { SportType, TierClassification } from '@prisma/client';

export class CreatePassportDto {
  @ApiProperty({ example: '2005-04-12', description: 'ISO format date of birth' })
  @IsString()
  @IsNotEmpty()
  readonly dateOfBirth!: string;

  @ApiProperty({ example: 'MALE' })
  @IsString()
  @IsNotEmpty()
  readonly gender!: string;

  @ApiProperty({ enum: SportType, example: SportType.CRICKET })
  @IsEnum(SportType)
  @IsNotEmpty()
  readonly primarySport!: SportType;

  @ApiPropertyOptional({ enum: SportType, isArray: true })
  @IsOptional()
  @IsEnum(SportType, { each: true })
  readonly secondarySports?: SportType[];

  @ApiProperty({ example: 'Varanasi' })
  @IsString()
  @IsNotEmpty()
  readonly district!: string;

  @ApiProperty({ example: 'Uttar Pradesh' })
  @IsString()
  @IsNotEmpty()
  readonly state!: string;

  @ApiPropertyOptional({ enum: TierClassification, default: TierClassification.RURAL })
  @IsOptional()
  @IsEnum(TierClassification)
  readonly tierClassification?: TierClassification;

  @ApiPropertyOptional({ example: 178.5, minimum: 50, maximum: 260 })
  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(260)
  readonly heightCm?: number;

  @ApiPropertyOptional({ example: 72.0, minimum: 20, maximum: 200 })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(200)
  readonly weightKg?: number;

  @ApiPropertyOptional({ example: 'RIGHT', enum: ['RIGHT', 'LEFT', 'BOTH'] })
  @IsOptional()
  @IsString()
  readonly dominantSide?: string;

  @ApiPropertyOptional({ example: 25.3176 })
  @IsOptional()
  @IsNumber()
  readonly locationLat?: number;

  @ApiPropertyOptional({ example: 82.9739 })
  @IsOptional()
  @IsNumber()
  readonly locationLng?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isScoutSearchable?: boolean;
}
