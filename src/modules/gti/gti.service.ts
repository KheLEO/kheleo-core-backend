import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SportType } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { WsEventGateway } from '../../infrastructure/realtime/ws-event.gateway';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { LeaderboardsService } from '../leaderboards/leaderboards.service';
import { LeaderboardPage, LeaderboardsQueryDto } from '../leaderboards/leaderboards.dto';
import { normalizeLocationName } from '../../common/constants/india-locations';
import { assertAccountAccess } from '../../common/auth/account-access';

export interface GtiComputationResult {
  readonly athleteId: string;
  readonly gti: number;
  readonly previousGti: number;
  readonly biomechanicalScore: number;
  readonly wearableScore: number;
  readonly matchPerformanceScore: number;
  readonly eliteBreached: boolean;
  readonly scoutAlertTriggered: boolean;
  readonly evidence: {
    readonly biomechanical: 'VERIFIED' | 'NOT_AVAILABLE';
    readonly wearable: 'VERIFIED' | 'NOT_AVAILABLE';
    readonly matchPerformance: 'VERIFIED' | 'NOT_AVAILABLE';
  };
  readonly provisional: boolean;
}
@Injectable()
export class GtiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboards: LeaderboardsService,
    private readonly queue: QueueProducerService,
    private readonly ws: WsEventGateway,
  ) {}
  computeCompositeGti(
    biomechanicalScore: number,
    wearableScore: number,
    matchPerfScore: number,
  ): number {
    return Number(
      Math.min(
        100,
        Math.max(0, biomechanicalScore * 0.35 + wearableScore * 0.25 + matchPerfScore * 0.4),
      ).toFixed(2),
    );
  }
  async recalculateAthleteGti(
    athleteId: string,
    triggerType = 'MANUAL_RECALCULATION',
  ): Promise<GtiComputationResult> {
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const include = { user: { include: { identityRecord: true } } } as const;
      const profile =
        (await tx.athleteProfile.findUnique({ where: { userId: athleteId }, include })) ??
        (await tx.athleteProfile.findUnique({ where: { id: athleteId }, include }));
      if (!profile) throw new NotFoundException('Athlete profile not found');
      assertAccountAccess(profile.user);
      const biomechanicalScore = profile.biomechanicalScore;
      const wearableScore = profile.trainingConsistencyScore;
      const matchPerformanceScore = profile.matchPerformanceScore;
      const gti = this.computeCompositeGti(
        biomechanicalScore,
        wearableScore,
        matchPerformanceScore,
      );
      const [drills, sessions, matches] = await Promise.all([
        tx.drillSubmission.count({ where: { athleteId: profile.userId } }),
        tx.wearableSession.count({ where: { athleteId: profile.userId } }),
        tx.verifiedMatchResult.count({
          where: {
            participantAthleteIds: { has: profile.userId },
            bracket: { tournament: { sport: profile.primarySport ?? undefined } },
          },
        }),
      ]);
      const evidence: GtiComputationResult['evidence'] = {
        biomechanical: drills > 0 ? 'VERIFIED' : 'NOT_AVAILABLE',
        wearable: sessions > 0 ? 'VERIFIED' : 'NOT_AVAILABLE',
        matchPerformance: matches > 0 ? 'VERIFIED' : 'NOT_AVAILABLE',
      };
      const provisional = Object.values(evidence).some((status) => status !== 'VERIFIED');
      const previousGti = profile.gti || Number(profile.currentGti);
      // Only write the derived composite. Component writers own their respective scores.
      await tx.athleteProfile.update({
        where: { id: profile.id },
        data: { gti, currentGti: new Prisma.Decimal(gti) },
      });
      await tx.gtiHistory.create({
        data: {
          athleteId: profile.id,
          biomechanicalScore: new Prisma.Decimal(biomechanicalScore),
          wearableScore: new Prisma.Decimal(wearableScore),
          matchScore: new Prisma.Decimal(matchPerformanceScore),
          compositeGti: new Prisma.Decimal(gti),
          calculationFactors: {
            w1: 0.35,
            w2: 0.25,
            w3: 0.4,
            calculationVersion: 'gti-v2',
            triggerType,
            evidence,
            provisional,
          },
        },
      });
      const eligible =
        profile.user.role === 'ATHLETE' &&
        profile.user.identityRecord?.status === 'VERIFIED' &&
        profile.isScoutSearchable &&
        profile.primarySport !== null &&
        !provisional;
      const rural =
        profile.isRuralOrUnderrepresented ||
        ['RURAL', 'TIER_3', 'TIER_2'].includes(profile.tierClassification);
      const existing =
        eligible && rural && gti >= 85
          ? await tx.scoutAlert.findFirst({
              where: {
                athleteId: profile.userId,
                sport: String(profile.primarySport),
                isAcknowledged: false,
              },
            })
          : null;
      const alert =
        existing ??
        (eligible && rural && gti >= 85
          ? await tx.scoutAlert.create({
              data: {
                athleteId: profile.userId,
                sport: String(profile.primarySport),
                district: profile.district,
                gtiScore: gti,
              },
            })
          : null);
      return {
        profile,
        gti,
        previousGti,
        biomechanicalScore,
        wearableScore,
        matchPerformanceScore,
        evidence,
        provisional,
        alert,
        created: alert !== null && existing === null,
      };
    });
    await this.leaderboards.syncAthlete(result.profile.userId);
    if (result.alert)
      await this.queue.enqueueScoutAlert({
        alertId: result.alert.id,
        athleteId: result.profile.userId,
        newGti: result.gti,
        sport: String(result.profile.primarySport),
        district: result.profile.district,
        state: result.profile.state,
        tierClassification: result.profile.tierClassification,
      });
    this.ws.broadcastGtiUpdated({
      athleteId: result.profile.userId,
      previousGti: result.previousGti,
      newGti: result.gti,
      eliteBreached: result.gti >= 85,
    });
    return {
      athleteId: result.profile.userId,
      gti: result.gti,
      previousGti: result.previousGti,
      biomechanicalScore: result.biomechanicalScore,
      wearableScore: result.wearableScore,
      matchPerformanceScore: result.matchPerformanceScore,
      eliteBreached: result.gti >= 85,
      scoutAlertTriggered: result.created,
      evidence: result.evidence,
      provisional: result.provisional,
    };
  }
  async calculateAthleteGti(athleteId: string): Promise<GtiComputationResult> {
    return this.recalculateAthleteGti(athleteId);
  }
  async getLeaderboards(query: LeaderboardsQueryDto): Promise<LeaderboardPage> {
    const normalizedQuery: LeaderboardsQueryDto = {
      ...query,
      state: query.state ? normalizeLocationName(query.state) : undefined,
      district: query.district ? normalizeLocationName(query.district) : undefined,
    };
    return this.leaderboards.list(normalizedQuery);
  }
  async getLeaderboardRank(
    sport: string,
    athleteId: string,
    district?: string,
  ): Promise<number | null> {
    if (!Object.values(SportType).some((value) => value === sport)) return null;
    const normalizedDistrict = district ? normalizeLocationName(district) : undefined;
    return this.leaderboards.rank(sport as SportType, athleteId, normalizedDistrict);
  }
}
