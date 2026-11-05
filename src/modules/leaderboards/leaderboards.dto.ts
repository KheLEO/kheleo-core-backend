import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SportType } from '@prisma/client';
export enum LeaderboardScope {
  NATIONAL = 'NATIONAL',
  STATE = 'STATE',
  DISTRICT = 'DISTRICT',
}
export class LeaderboardsQueryDto {
  @IsEnum(SportType) sport!: SportType;
  @IsEnum(LeaderboardScope) scope: LeaderboardScope = LeaderboardScope.NATIONAL;
  @IsOptional() @IsString() @MaxLength(100) state?: string;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @IsString() @MaxLength(800) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export interface LeaderboardEntry {
  rank: number;
  athleteId: string;
  district: string;
  state: string;
  sport: SportType;
  gti: number;
  biomechanicalScore: number;
  wearableScore: number;
  matchPerformanceScore: number;
}
export interface LeaderboardPage {
  data: LeaderboardEntry[];
  nextCursor: string | null;
  source: 'redis' | 'database';
}
export interface LeaderboardCursor {
  id: string;
  score: number;
  scope: string;
}
