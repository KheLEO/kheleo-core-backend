import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AlertSeverity, Prisma, ScoutDossier, UserRole, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { OutreachDto, OutreachAction } from './dto/outreach.dto';

export interface OutreachEvent {
  actionType: OutreachAction;
  notes: string;
  organizationName: string | null;
  recordedAt: string;
}
function outreachHistory(value: Prisma.JsonValue): OutreachEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !['OFFER_TRIAL', 'SPONSORSHIP_INQUIRY', 'SHORTLIST_BOOKMARK'].includes(
        String(entry.actionType),
      ) ||
      typeof entry.notes !== 'string' ||
      typeof entry.recordedAt !== 'string'
    )
      return [];
    return [
      {
        actionType: entry.actionType as OutreachAction,
        notes: entry.notes,
        organizationName:
          typeof entry.organizationName === 'string' ? entry.organizationName : null,
        recordedAt: entry.recordedAt,
      },
    ];
  });
}
interface DossierHistoryEntry {
  gti: number;
  biomechanical_score: number;
  wearable_consistency_score: number;
  match_performance_score: number;
  calculated_at: Date;
  recorded_at: Date;
  trigger_type: string;
}
interface DossierDrillEntry {
  id: string;
  drill_type: string;
  sport: string;
  form_score: number;
  frames_analyzed: number;
  flaw_flags: Prisma.JsonValue;
  signature_hash_prefix: string;
  created_at: Date;
}
interface DossierSportEntry {
  sport: string;
  primary_role: string;
  secondary_roles: readonly string[];
  total_matches: number;
  win_count: number;
  win_streak: number;
}
export interface AthleteDossierResponse {
  athlete_id: string;
  profile_id: string;
  display_name: string;
  district: string;
  state: string;
  tier_classification: string;
  primary_sport: string | null;
  secondary_sports: readonly string[];
  is_verified: boolean;
  verification_status: string;
  physical_stats: {
    gender: string | null;
    height_cm: number | null;
    weight_kg: number | null;
    dominant_side: string | null;
  };
  gti_breakdown: {
    gti: number;
    biomechanical_score: number;
    wearable_consistency_score: number;
    match_performance_score: number;
    posture_points: number;
  };
  gti_history: readonly DossierHistoryEntry[];
  recent_drills: readonly DossierDrillEntry[];
  wearable_summary: {
    sessions_monitored: number;
    readings_count: number;
    avg_heart_rate: number | null;
    avg_spo2: number | null;
    safety_pauses_count: number;
    consistency_score: number;
    simulator_readings: number;
    baseline_spo2_readings: number;
  };
  physiological_resilience: {
    status: AlertSeverity | 'no_data';
    observed_alerts: number;
    latest_alert_at: Date | null;
    match_paused: boolean | null;
  };
  sport_records: readonly DossierSportEntry[];
  scout_outreach: {
    is_shortlisted: boolean;
    pipeline_status: string;
    notes: string;
    organization_name: string | null;
    history: OutreachEvent[];
  } | null;
}
export function assertDossierVisibility(
  userId: string,
  isSearchable: boolean,
  viewer: AuthenticatedJwtUser,
): void {
  const allowed: readonly string[] = [
    UserRole.SCOUT,
    UserRole.FEDERATION_ADMIN,
    UserRole.SUPER_ADMIN,
  ];
  if (viewer.sub !== userId && !allowed.includes(viewer.role))
    throw new ForbiddenException('You cannot view this athlete dossier');
  if (viewer.role === UserRole.SCOUT && viewer.sub !== userId && !isSearchable)
    throw new ForbiddenException('Athlete profile is not opted into scout discovery');
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
        gender: true,
        heightCm: true,
        weightKg: true,
        dominantSide: true,
        tierClassification: true,
        primarySport: true,
        secondarySports: true,
        isScoutSearchable: true,
        gti: true,
        currentGti: true,
        biomechanicalScore: true,
        trainingConsistencyScore: true,
        matchPerformanceScore: true,
        posturePoints: true,
        gtiHistories: {
          orderBy: [{ calculatedAt: 'asc' }, { id: 'asc' }],
          select: {
            compositeGti: true,
            biomechanicalScore: true,
            wearableScore: true,
            matchScore: true,
            calculatedAt: true,
            calculationFactors: true,
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
            isActive: true,
            identityRecord: { select: { status: true } },
            drillSubmissions: {
              where: { metadataVerified: true, signatureVersion: { in: ['FULL', 'FULL_V2'] } },
              take: 10,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                id: true,
                drillType: true,
                sport: true,
                formScore: true,
                framesAnalyzed: true,
                flawFlags: true,
                signatureHash: true,
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
    if (
      viewer.role === 'SCOUT' &&
      (!profile.user.isActive || profile.user.identityRecord?.status !== 'VERIFIED')
    )
      throw new ForbiddenException('Athlete is not available for scout discovery');
    const [sessions, sums, pauses, saved] = await Promise.all([
      this.prisma.wearableSession.count({ where: { athleteId: userId } }),
      this.prisma.wearableSession.aggregate({
        where: { athleteId: userId },
        _sum: {
          readingsCount: true,
          heartRateSum: true,
          spo2Sum: true,
          simulatorReadings: true,
          baselineSpo2Readings: true,
        },
      }),
      this.prisma.healthAlert.count({ where: { athleteId: userId, matchPaused: true } }),
      viewer.sub === userId
        ? Promise.resolve(null)
        : this.prisma.scoutDossier.findUnique({
            where: { athleteId_scoutId: { athleteId: profile.id, scoutId: viewer.sub } },
          }),
    ]);
    const count = sums._sum.readingsCount ?? 0;
    const latestAlert = profile.user.healthAlerts[0];
    return {
      athlete_id: profile.userId,
      profile_id: profile.id,
      display_name: `Athlete ${profile.userId.slice(0, 8)}`,
      district: profile.district,
      state: profile.state,
      tier_classification: profile.tierClassification,
      primary_sport: profile.primarySport,
      secondary_sports: profile.secondarySports,
      is_verified: profile.user.identityRecord?.status === VerificationStatus.VERIFIED,
      verification_status: profile.user.identityRecord?.status ?? 'UNVERIFIED',
      physical_stats: {
        gender: profile.gender,
        height_cm: profile.heightCm === null ? null : Number(profile.heightCm),
        weight_kg: profile.weightKg === null ? null : Number(profile.weightKg),
        dominant_side: profile.dominantSide,
      },
      gti_breakdown: {
        gti: profile.gti || Number(profile.currentGti),
        biomechanical_score: profile.biomechanicalScore,
        wearable_consistency_score: profile.trainingConsistencyScore,
        match_performance_score: profile.matchPerformanceScore,
        posture_points: profile.posturePoints,
      },
      gti_history: profile.gtiHistories.map((entry) => ({
        gti: Number(entry.compositeGti),
        biomechanical_score: Number(entry.biomechanicalScore),
        wearable_consistency_score: Number(entry.wearableScore),
        match_performance_score: Number(entry.matchScore),
        calculated_at: entry.calculatedAt,
        recorded_at: entry.calculatedAt,
        trigger_type:
          entry.calculationFactors &&
          typeof entry.calculationFactors === 'object' &&
          !Array.isArray(entry.calculationFactors) &&
          typeof entry.calculationFactors.triggerType === 'string'
            ? entry.calculationFactors.triggerType
            : 'LEGACY_UNSPECIFIED',
      })),
      recent_drills: profile.user.drillSubmissions.map((entry) => ({
        id: entry.id,
        drill_type: entry.drillType,
        sport: entry.sport,
        form_score: entry.formScore,
        frames_analyzed: entry.framesAnalyzed,
        flaw_flags: entry.flawFlags,
        signature_hash_prefix: entry.signatureHash.slice(0, 12),
        created_at: entry.createdAt,
      })),
      wearable_summary: {
        sessions_monitored: sessions,
        readings_count: count,
        avg_heart_rate: count ? Number(((sums._sum.heartRateSum ?? 0) / count).toFixed(2)) : null,
        avg_spo2: count ? Number(((sums._sum.spo2Sum ?? 0) / count).toFixed(2)) : null,
        safety_pauses_count: pauses,
        consistency_score: profile.trainingConsistencyScore,
        simulator_readings: sums._sum.simulatorReadings ?? 0,
        baseline_spo2_readings: sums._sum.baselineSpo2Readings ?? 0,
      },
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
      scout_outreach: saved
        ? {
            is_shortlisted: saved.isShortlisted,
            pipeline_status: saved.pipelineStatus,
            notes: saved.scoutNotes,
            organization_name: saved.organizationName,
            history: outreachHistory(saved.outreachHistory),
          }
        : null,
    };
  }
  async outreach(
    userId: string,
    viewer: AuthenticatedJwtUser,
    dto: OutreachDto,
  ): Promise<ScoutDossier> {
    if (!['SCOUT', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(viewer.role))
      throw new ForbiddenException('Scout outreach role is required');
    if (!dto.actionType && !dto.outreachType && !dto.notes?.trim())
      throw new BadRequestException('Specify an outreach action');
    const actionType =
      dto.actionType ??
      (dto.outreachType === 'SCHOLARSHIP' ? 'SPONSORSHIP_INQUIRY' : 'OFFER_TRIAL');
    if (
      dto.actionType &&
      dto.outreachType &&
      dto.actionType !== (dto.outreachType === 'TRIAL' ? 'OFFER_TRIAL' : 'SPONSORSHIP_INQUIRY')
    )
      throw new BadRequestException('Conflicting outreach action types');
    return runSerializableTransaction(this.prisma, async (tx) => {
      const profile = await tx.athleteProfile.findUnique({
        where: { userId },
        select: {
          id: true,
          isScoutSearchable: true,
          user: { select: { isActive: true, identityRecord: { select: { status: true } } } },
        },
      });
      if (!profile) throw new NotFoundException('Athlete passport not found');
      assertDossierVisibility(userId, profile.isScoutSearchable, viewer);
      if (
        viewer.role === 'SCOUT' &&
        (!profile.user.isActive || profile.user.identityRecord?.status !== 'VERIFIED')
      )
        throw new ForbiddenException('Athlete is not available for scout discovery');
      const where = { athleteId_scoutId: { athleteId: profile.id, scoutId: viewer.sub } };
      const previous = await tx.scoutDossier.findUnique({ where });
      const event: OutreachEvent = {
        actionType,
        notes: dto.notes?.trim() ?? '',
        organizationName: dto.organizationName?.trim() ?? previous?.organizationName ?? null,
        recordedAt: new Date().toISOString(),
      };
      const data = {
        scoutNotes: dto.notes?.trim() ?? previous?.scoutNotes ?? '',
        organizationName: event.organizationName,
        isShortlisted: actionType === 'SHORTLIST_BOOKMARK' || previous?.isShortlisted === true,
        pipelineStatus:
          actionType === 'SHORTLIST_BOOKMARK'
            ? (previous?.pipelineStatus ?? 'DISCOVERED')
            : actionType === 'OFFER_TRIAL'
              ? 'TRIAL_OUTREACH'
              : 'SCHOLARSHIP_OUTREACH',
        outreachHistory: [
          ...outreachHistory(previous?.outreachHistory ?? []),
          event,
        ] as unknown as Prisma.InputJsonArray,
      };
      return tx.scoutDossier.upsert({
        where,
        create: { athleteId: profile.id, scoutId: viewer.sub, ...data },
        update: data,
      });
    });
  }
}
