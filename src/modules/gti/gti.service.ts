import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, SportType } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { WsEventGateway } from '../../infrastructure/realtime/ws-event.gateway';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { CACHE_KEYS, invalidateCacheKeys } from '../../infrastructure/cache/cache-helper';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { LeaderboardsService } from '../leaderboards/leaderboards.service';
import { LeaderboardPage, LeaderboardsQueryDto } from '../leaderboards/leaderboards.dto';
import { normalizeLocationName } from '../../common/constants/india-locations';
import { assertAccountAccess } from '../../common/auth/account-access';
import { evaluateGtiBreakdown } from './gti-score-reconciliation';
import {
  outboxIdMatches,
  deliverDirectOutbox,
  signalOutboxWakeup,
} from '../../infrastructure/outbox/outbox-authority';

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
  readonly weights: { readonly w1: number; readonly w2: number; readonly w3: number };
  readonly calculationMode: 'ONBOARDING_BASELINE' | 'WEIGHTED';
}
@Injectable()
export class GtiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboards: LeaderboardsService,
    private readonly queue: QueueProducerService,
    private readonly ws: WsEventGateway,
    @Optional() private readonly redis?: RedisService,
  ) {}
  computeCompositeGti(
    biomechanicalScore: number,
    wearableScore: number,
    matchPerfScore: number,
    weights?: { w1: number; w2: number; w3: number },
  ): number {
    const w1 = weights?.w1 ?? 0.35;
    const w2 = weights?.w2 ?? 0.25;
    const w3 = weights?.w3 ?? 0.4;
    return Number(
      Math.min(
        100,
        Math.max(0, biomechanicalScore * w1 + wearableScore * w2 + matchPerfScore * w3),
      ).toFixed(2),
    );
  }
  async recalculateAthleteGti(
    athleteId: string,
    triggerType = 'MANUAL_RECALCULATION',
    deliveryId?: string,
  ): Promise<GtiComputationResult> {
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const include = { user: { include: { identityRecord: true } } } as const;
      const profile =
        (await tx.athleteProfile.findUnique({ where: { userId: athleteId }, include })) ??
        (await tx.athleteProfile.findUnique({ where: { id: athleteId }, include }));
      if (!profile) throw new NotFoundException('Athlete profile not found');
      assertAccountAccess(profile.user);
      if (deliveryId) {
        const previous = await tx.gtiHistory.findFirst({
          where: {
            athleteId: profile.id,
            calculationFactors: { path: ['deliveryId'], equals: deliveryId },
          },
        });
        if (previous) {
          const stored = (previous.calculationFactors as Prisma.JsonObject).deliveryResult;
          if (!stored || typeof stored !== 'object' || Array.isArray(stored))
            throw new Error('Invalid GTI delivery receipt');
          return {
            profile,
            ...(stored as unknown as GtiComputationResult),
            alert: null,
            created: false,
            replayed: true,
          };
        }
      }
      const biomechanicalScore = profile.biomechanicalScore ?? 0;
      const wearableScore = profile.trainingConsistencyScore ?? 0;
      const matchPerformanceScore = profile.matchPerformanceScore ?? 0;

      const [drills, sessions, healthAlerts, matches, sportRecords] = await Promise.all([
        tx.drillSubmission.count({ where: { athleteId: profile.userId } }),
        tx.wearableSession.count({ where: { athleteId: profile.userId } }),
        tx.healthAlert.count({ where: { athleteId: profile.userId } }),
        tx.verifiedMatchResult.count({
          where: {
            participantAthleteIds: { has: profile.userId },
            bracket: { tournament: { sport: profile.primarySport ?? undefined } },
          },
        }),
        tx.sportPassportRecord.findMany({
          where: {
            athleteId: profile.id,
            ...(profile.primarySport ? { sport: profile.primarySport } : {}),
          },
          select: { totalMatches: true },
        }),
      ]);

      const totalMatches = (sportRecords ?? []).reduce((sum, r) => sum + (r.totalMatches || 0), 0);
      const { gti, w1, w2, w3, evidence, provisional, isUnmeasuredOnboarding } =
        evaluateGtiBreakdown({
          biomechanicalScore,
          wearableScore,
          matchPerformanceScore,
          drillsCount: drills,
          sessionsCount: sessions,
          healthAlertsCount: healthAlerts,
          matchesCount: matches,
          totalPassportMatches: totalMatches,
          onboardingGti: Number(profile.currentGti) > 0 ? Number(profile.currentGti) : 30,
        });
      const previousGti = profile.gti || Number(profile.currentGti);
      const calculationMode = isUnmeasuredOnboarding
        ? ('ONBOARDING_BASELINE' as const)
        : ('WEIGHTED' as const);

      const effectiveWearableScore =
        isUnmeasuredOnboarding && wearableScore === 0
          ? Number(profile.wearableScore) > 0
            ? Number(profile.wearableScore)
            : 50
          : wearableScore;
      const effectiveMatchScore =
        isUnmeasuredOnboarding && matchPerformanceScore === 0
          ? Number(profile.matchPerfScore) > 0
            ? Number(profile.matchPerfScore)
            : 50
          : matchPerformanceScore;

      // Only write the derived composite. Component writers own their respective scores.
      await tx.athleteProfile.update({
        where: { id: profile.id },
        data: { gti, currentGti: new Prisma.Decimal(gti) },
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
                district: profile.district ?? '',
                gtiScore: gti,
              },
            })
          : null);
      await tx.gtiHistory.create({
        data: {
          athleteId: profile.id,
          biomechanicalScore: new Prisma.Decimal(biomechanicalScore),
          wearableScore: new Prisma.Decimal(effectiveWearableScore),
          matchScore: new Prisma.Decimal(effectiveMatchScore),
          compositeGti: new Prisma.Decimal(gti),
          calculationFactors: {
            w1,
            w2,
            w3,
            calculationVersion: 'gti-v2',
            triggerType,
            evidence,
            provisional,
            ...(deliveryId
              ? {
                  deliveryId,
                  deliveryResult: {
                    athleteId: profile.userId,
                    gti,
                    previousGti,
                    biomechanicalScore,
                    wearableScore: effectiveWearableScore,
                    matchPerformanceScore: effectiveMatchScore,
                    eliteBreached: gti >= 85,
                    scoutAlertTriggered: alert !== null && existing === null,
                    evidence,
                    provisional,
                    weights: { w1, w2, w3 },
                    calculationMode,
                  },
                }
              : {}),
            ...(isUnmeasuredOnboarding ? { calculationMode, baselineGti: gti } : {}),
          },
        },
      });
      return {
        replayed: false,
        profile,
        gti,
        previousGti,
        biomechanicalScore,
        wearableScore: effectiveWearableScore,
        matchPerformanceScore: effectiveMatchScore,
        evidence,
        provisional,
        alert,
        created: alert !== null && existing === null,
        weights: { w1, w2, w3 },
        calculationMode,
      };
    });
    const response: GtiComputationResult = {
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
      weights: result.weights,
      calculationMode: result.calculationMode,
    };
    if (result.replayed) {
      signalOutboxWakeup();
      return response;
    }
    await invalidateCacheKeys(this.redis, [CACHE_KEYS.passport(result.profile.userId)]);
    await deliverDirectOutbox(
      this.prisma,
      result,
      'LEADERBOARD',
      (payload) => outboxIdMatches(payload.athleteId, result.profile.userId),
      () => this.leaderboards.syncAthlete(result.profile.userId, undefined, true),
    );
    if (result.alert)
      await deliverDirectOutbox(
        this.prisma,
        result,
        'SCOUT',
        (payload) => outboxIdMatches(payload.alertId, result.alert!.id),
        () =>
          this.queue.enqueueScoutAlert({
            alertId: result.alert!.id,
            athleteId: result.profile.userId,
            newGti: result.gti,
            sport: String(result.profile.primarySport),
            district: result.profile.district ?? '',
            state: result.profile.state ?? '',
            tierClassification: result.profile.tierClassification,
          }),
      );
    await deliverDirectOutbox(
      this.prisma,
      result,
      'GTI_UPDATED',
      (payload) => outboxIdMatches(payload.athleteId, result.profile.userId),
      (event) =>
        this.ws.broadcastGtiUpdated({
          eventId: event?.id,
          athleteId: result.profile.userId,
          previousGti: result.previousGti,
          newGti: result.gti,
          eliteBreached: result.gti >= 85,
        }),
    );
    return response;
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
