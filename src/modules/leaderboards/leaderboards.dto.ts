import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SportType } from '@prisma/client';
export enum LeaderboardScope {
  NATIONAL = 'NATIONAL',
  STATE = 'STATE',
  DISTRICT = 'DISTRICT',
}
export class LeaderboardsQueryDto {
  @IsOptional() @IsIn([...Object.values(SportType), 'ALL']) sport?: SportType | 'ALL';
  @IsEnum(LeaderboardScope) scope: LeaderboardScope = LeaderboardScope.NATIONAL;
  @IsOptional() @IsString() @MaxLength(100) state?: string;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @IsIn(['ALL', 'RURAL_AND_TIER_2_3']) tier?: 'ALL' | 'RURAL_AND_TIER_2_3';
  @IsOptional() @IsString() @MaxLength(16) gender?: string;
  @IsOptional() @IsUUID() cursor_id?: string;
  @IsOptional() @IsString() @MaxLength(800) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export interface LeaderboardRow {
  rank: number;
  athleteId: string;
  profileId: string;
  district: string;
  state: string;
  sport: SportType;
  gti: number;
  biomechanicalScore: number;
  wearableScore: number;
  matchPerformanceScore: number;
  gender: string | null;
  tierClassification: string;
  primaryRole: string | null;
  totalMatches: number;
  winCount: number;
}
export interface LeaderboardEntry extends LeaderboardRow {
  athlete_id: string;
  profile_id: string;
  display_name: string;
  tier_classification: string;
  primary_sport: SportType;
  primary_role: string | null;
  biomechanical_score: number;
  wearable_consistency_score: number;
  match_performance_score: number;
  win_rate: number;
  total_matches: number;
}
export interface LeaderboardPage {
  success: true;
  scope: LeaderboardScope;
  total: number;
  has_more: boolean;
  next_cursor: string | null;
  data: LeaderboardEntry[];
  nextCursor: string | null;
  source: 'redis' | 'database';
}
export interface LeaderboardCursor {
  id: string;
  score: number;
  scope: string;
}
