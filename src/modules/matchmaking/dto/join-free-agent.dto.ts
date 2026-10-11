import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class JoinFreeAgentDto {
  @ApiProperty({
    description: 'Primary role of the athlete (e.g. BATSMAN, BOWLER, ALL_ROUNDER, WICKETKEEPER, GOALKEEPER, DEFENDER, MIDFIELDER, FORWARD)',
    example: 'BATSMAN',
  })
  @IsString()
  @IsNotEmpty()
  readonly primary_role!: string;

  @ApiPropertyOptional({
    description: 'Optional secondary fallback role for complementary team balancing',
    example: 'ALL_ROUNDER',
  })
  @IsOptional()
  @IsString()
  readonly secondary_role?: string;
}
