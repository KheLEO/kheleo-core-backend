import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { SportType, TierClassification } from '@prisma/client';

export class UpdatePassportDto {
  @ApiPropertyOptional({ enum: SportType })
  @IsOptional()
  @IsEnum(SportType)
  readonly primarySport?: SportType;

  @ApiPropertyOptional({ enum: SportType, isArray: true })
  @IsOptional()
  @IsEnum(SportType, { each: true })
  readonly secondarySports?: SportType[];

  @ApiPropertyOptional({ example: 'Varanasi' })
  @IsOptional()
  @IsString()
  readonly district?: string;

  @ApiPropertyOptional({ example: 'Uttar Pradesh' })
  @IsOptional()
  @IsString()
  readonly state?: string;

  @ApiPropertyOptional({ enum: TierClassification })
  @IsOptional()
  @IsEnum(TierClassification)
  readonly tierClassification?: TierClassification;

  @ApiPropertyOptional({ example: 179.0, minimum: 50, maximum: 260 })
  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(260)
  readonly heightCm?: number;

  @ApiPropertyOptional({ example: 73.5, minimum: 20, maximum: 200 })
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

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  readonly isScoutSearchable?: boolean;
}
