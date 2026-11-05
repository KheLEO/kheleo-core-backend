import { ApiProperty } from '@nestjs/swagger';
import { SportType, TierClassification, VerificationStatus } from '@prisma/client';

export class VerifiedPhysicalStatsDto {
  @ApiProperty({ example: 178.5, nullable: true })
  readonly heightCm!: number | null;

  @ApiProperty({ example: 71.0, nullable: true })
  readonly weightKg!: number | null;

  @ApiProperty({ example: 'RIGHT', nullable: true })
  readonly dominantSide!: string | null;
}

export class SportPassportRecordSummaryDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  readonly id!: string;

  @ApiProperty({ enum: SportType, example: SportType.CRICKET })
  readonly sport!: SportType;

  @ApiProperty({ example: 'ALL_ROUNDER' })
  readonly primaryRole!: string;

  @ApiProperty({ example: ['FAST_BOWLER'] })
  readonly secondaryRoles!: string[];

  @ApiProperty({ example: 18 })
  readonly totalMatches!: number;

  @ApiProperty({ example: 14 })
  readonly winCount!: number;

  @ApiProperty({ example: 5 })
  readonly winStreak!: number;

  @ApiProperty({ example: { bowlingSpeedKmh: 132.4 } })
  readonly verifiedMetrics!: Record<string, unknown>;

  @ApiProperty({ example: [{ id: 'centurion', title: 'Centurion' }] })
  readonly earnedBadges!: Array<Record<string, unknown>>;

  @ApiProperty()
  readonly updatedAt!: Date;
}

export class AthletePassportDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  readonly userId!: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174001' })
  readonly athleteProfileId!: string;

  @ApiProperty({ example: '2005-04-12', type: String, format: 'date', nullable: true })
  readonly dateOfBirth!: Date | null;

  @ApiProperty({ example: 'MALE', type: String, nullable: true })
  readonly gender!: string | null;

  @ApiProperty({ enum: SportType, example: SportType.CRICKET, nullable: true })
  readonly primarySport!: SportType | null;

  @ApiProperty({ enum: SportType, isArray: true })
  readonly secondarySports!: SportType[];

  @ApiProperty({ example: 'Varanasi' })
  readonly district!: string;

  @ApiProperty({ example: 'Uttar Pradesh' })
  readonly state!: string;

  @ApiProperty({ enum: TierClassification, example: TierClassification.RURAL })
  readonly tierClassification!: TierClassification;

  @ApiProperty({ nullable: true, type: Number })
  readonly locationLat!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  readonly locationLng!: number | null;

  @ApiProperty()
  readonly isScoutSearchable!: boolean;

  @ApiProperty()
  readonly isProfileComplete!: boolean;

  @ApiProperty({ type: VerifiedPhysicalStatsDto })
  readonly physicalStats!: VerifiedPhysicalStatsDto;

  @ApiProperty({
    example: 72.5,
    description: 'Composite Grassroots Talent Index (0-100)',
  })
  readonly currentGti!: number;

  @ApiProperty({ example: 85.0 })
  readonly wearableScore!: number;

  @ApiProperty({ example: 78.5 })
  readonly matchPerfScore!: number;

  @ApiProperty({ example: 120 })
  readonly posturePoints!: number;

  @ApiProperty({ example: 65.0, description: 'Biomechanical form score (0-100)' })
  readonly biomechanicalScore!: number;

  @ApiProperty({
    enum: VerificationStatus,
    example: VerificationStatus.VERIFIED,
  })
  readonly identityStatus!: VerificationStatus;

  @ApiProperty({ type: [SportPassportRecordSummaryDto] })
  readonly sportRecords!: SportPassportRecordSummaryDto[];

  @ApiProperty({ description: 'Aggregated badges across all sports' })
  readonly allBadges!: Array<Record<string, unknown>>;
}
