import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { SportType } from '@prisma/client';

export class AddSportRecordDto {
  @ApiProperty({ enum: SportType, example: SportType.CRICKET })
  @IsEnum(SportType)
  @IsNotEmpty()
  readonly sport!: SportType;

  @ApiProperty({ example: 'ALL_ROUNDER' })
  @IsString()
  @IsNotEmpty()
  readonly primaryRole!: string;

  @ApiPropertyOptional({ example: ['FAST_BOWLER', 'MIDDLE_ORDER_BATSMAN'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  readonly secondaryRoles?: string[];

  @ApiPropertyOptional({
    example: { bowlingSpeedKmh: 132.4, battingStrikeRate: 145.2 },
    description: 'Verified Edge-AI metrics',
  })
  @IsOptional()
  @IsObject()
  readonly verifiedMetrics?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: [{ id: 'centurion', title: 'Centurion', dateEarned: '2026-09-01' }],
  })
  @IsOptional()
  @IsArray()
  readonly earnedBadges?: Array<Record<string, unknown>>;
}
