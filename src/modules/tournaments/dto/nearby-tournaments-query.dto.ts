import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SportType } from '@prisma/client';

export class NearbyTournamentsQueryDto {
  @ApiProperty({
    description: 'Latitude coordinate of searching location',
    example: 25.3176,
  })
  @IsNotEmpty()
  @IsLatitude()
  @Type(() => Number)
  readonly lat!: number;

  @ApiProperty({
    description: 'Longitude coordinate of searching location',
    example: 82.9739,
  })
  @IsNotEmpty()
  @IsLongitude()
  @Type(() => Number)
  readonly lng!: number;

  @ApiPropertyOptional({
    description: 'Radius in kilometers for PostGIS spatial search (default 50)',
    example: 50,
    default: 50,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  readonly radius_km: number = 50;

  @ApiPropertyOptional({
    enum: SportType,
    description: 'Filter by sport type',
    example: SportType.CRICKET,
  })
  @IsOptional()
  @IsEnum(SportType)
  readonly sport?: SportType;

  @ApiPropertyOptional({
    description: 'Cursor ID for next page of tournaments',
  })
  @IsOptional()
  @IsUUID()
  readonly cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of tournaments to return (max 100)',
    default: 20,
    example: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  readonly limit: number = 20;
}
