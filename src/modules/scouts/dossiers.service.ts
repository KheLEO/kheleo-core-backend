import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertSeverity, Prisma, ScoutDossier, UserRole, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { OutreachDto } from './dto/outreach.dto';

interface DossierHistoryEntry {
  readonly gti: number;
  readonly biomechanical_score: number;
  readonly wearable_consistency_score: number;
  readonly match_performance_score: number;
  readonly calculated_at: Date;
}

interface DossierDrillEntry {
  readonly drill_type: string;
  readonly sport: string;
  readonly form_score: number;
  readonly flaw_flags: Prisma.JsonValue;
  readonly created_at: Date;
}

interface DossierSportEntry {
  readonly sport: string;
  readonly primary_role: string;
  readonly secondary_roles: readonly string[];
  readonly total_matches: number;
  readonly win_count: number;
  readonly win_streak: number;
}

export interface AthleteDossierResponse {
  readonly athlete_id: string;
  readonly profile_id: string;
  readonly district: string;
  readonly state: string;
  readonly tier_classification: string;
  readonly primary_sport: string | null;
  readonly secondary_sports: readonly string[];
  readonly is_verified: boolean;
  readonly gti_breakdown: {
    readonly gti: number;
    readonly biomechanical_score: number;
    readonly wearable_consistency_score: number;
    readonly match_performance_score: number;
    readonly posture_points: number;
  };
  readonly gti_history: readonly DossierHistoryEntry[];
  readonly recent_drills: readonly DossierDrillEntry[];
  readonly physiological_resilience: {
    readonly status: AlertSeverity | 'no_data';
    readonly observed_alerts: number;
    readonly latest_alert_at: Date | null;
    readonly match_paused: boolean | null;
  };
  readonly sport_records: readonly DossierSportEntry[];
}

export function assertDossierVisibility(
  userId: string,
  isSearchable: boolean,
  viewer: AuthenticatedJwtUser,
): void {
  const allowed: readonly string[] = [
    UserRole.SCOUT,
    UserRole.ORGANIZER,
    UserRole.FEDERATION_ADMIN,
    UserRole.SUPER_ADMIN,
  ];
  if (viewer.sub !== userId && !allowed.includes(viewer.role)) {
    throw new ForbiddenException('You cannot view this athlete dossier');
  }
  if (viewer.role === UserRole.SCOUT && viewer.sub !== userId && !isSearchable) {
    throw new ForbiddenException('Athlete profile is not opted into scout discovery');
  }
}

@Injectable()
export class ScoutsDossiersService {
  constructor(private readonly prisma: PrismaService) {}

  async getDossier(userId: string, viewer: AuthenticatedJwtUser): Promise<AthleteDossierResponse> {
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        userId: true,
        district: true,
        state: true,
        tierClassification: true,
        primarySport: true,
        secondarySports: true,
        isScoutSearchable: true,
        gti: true,
        currentGti: true,
        biomechanicalScore: true,
        trainingConsistencyScore: true,
        wearableScore: true,
        matchPerformanceScore: true,
        matchPerfScore: true,
        posturePoints: true,
        gtiHistories: {
          take: 20,
          orderBy: [{ calculatedAt: 'desc' }, { id: 'desc' }],
          select: {
            compositeGti: true,
            biomechanicalScore: true,
            wearableScore: true,
            matchScore: true,
            calculatedAt: true,
          },
        },
        sportRecords: {
          take: 6,
          orderBy: { sport: 'asc' },
          select: {
            sport: true,
            primaryRole: true,
            secondaryRoles: true,
            totalMatches: true,
            winCount: true,
            winStreak: true,
          },
        },
        user: {
          select: {
            identityRecord: { select: { status: true } },
            drillSubmissions: {
              take: 10,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                drillType: true,
                sport: true,
                formScore: true,
                flawFlags: true,
                createdAt: true,
              },
            },
            healthAlerts: {
              take: 10,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { severity: true, matchPaused: true, createdAt: true },
            },
          },
        },
      },
    });
    if (!profile) throw new NotFoundException('Athlete passport not found');
    assertDossierVisibility(userId, profile.isScoutSearchable, viewer);
    const latestAlert = profile.user.healthAlerts[0];
    return {
      athlete_id: profile.userId,
      profile_id: profile.id,
      district: profile.district,
      state: profile.state,
      tier_classification: profile.tierClassification,
      primary_sport: profile.primarySport,
      secondary_sports: profile.secondarySports,
      is_verified: profile.user.identityRecord?.status === VerificationStatus.VERIFIED,
      gti_breakdown: {
        gti: profile.gti > 0 ? profile.gti : Number(profile.currentGti),
        biomechanical_score: profile.biomechanicalScore,
        wearable_consistency_score:
          profile.trainingConsistencyScore > 0
            ? profile.trainingConsistencyScore
            : Number(profile.wearableScore),
        match_performance_score:
          profile.matchPerformanceScore > 0
            ? profile.matchPerformanceScore
            : Number(profile.matchPerfScore),
        posture_points: profile.posturePoints,
      },
      gti_history: profile.gtiHistories.map((entry) => ({
        gti: Number(entry.compositeGti),
        biomechanical_score: Number(entry.biomechanicalScore),
        wearable_consistency_score: Number(entry.wearableScore),
        match_performance_score: Number(entry.matchScore),
        calculated_at: entry.calculatedAt,
      })),
      recent_drills: profile.user.drillSubmissions.map((entry) => ({
        drill_type: entry.drillType,
        sport: entry.sport,
        form_score: entry.formScore,
        flaw_flags: entry.flawFlags,
        created_at: entry.createdAt,
      })),
      physiological_resilience: {
        status: latestAlert?.severity ?? 'no_data',
        observed_alerts: profile.user.healthAlerts.length,
        latest_alert_at: latestAlert?.createdAt ?? null,
        match_paused: latestAlert?.matchPaused ?? null,
      },
      sport_records: profile.sportRecords.map((entry) => ({
        sport: entry.sport,
        primary_role: entry.primaryRole,
        secondary_roles: entry.secondaryRoles,
        total_matches: entry.totalMatches,
        win_count: entry.winCount,
        win_streak: entry.winStreak,
      })),
    };
  }

  async outreach(
    userId: string,
    viewer: AuthenticatedJwtUser,
    dto: OutreachDto,
  ): Promise<ScoutDossier> {
    const roles: readonly string[] = [
      UserRole.SCOUT,
      UserRole.FEDERATION_ADMIN,
      UserRole.SUPER_ADMIN,
    ];
    if (!roles.includes(viewer.role))
      throw new ForbiddenException('Scout outreach role is required');
    return runSerializableTransaction(this.prisma, async (transaction) => {
      const profile = await transaction.athleteProfile.findUnique({
        where: { userId },
        select: { id: true, isScoutSearchable: true },
      });
      if (!profile) throw new NotFoundException('Athlete passport not found');
      assertDossierVisibility(userId, profile.isScoutSearchable, viewer);
      const data = {
        scoutNotes: dto.notes,
        pipelineStatus: `${dto.outreachType ?? 'TRIAL'}_OUTREACH`,
      };
      return transaction.scoutDossier.upsert({
        where: { athleteId_scoutId: { athleteId: profile.id, scoutId: viewer.sub } },
        create: { athleteId: profile.id, scoutId: viewer.sub, ...data },
        update: data,
      });
    });
  }
}
