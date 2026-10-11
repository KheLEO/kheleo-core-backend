import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { WsEventGateway } from '../../infrastructure/realtime/ws-event.gateway';
import { Prisma } from '@prisma/client';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';

export interface GtiComputationResult {
  readonly athleteId: string;
  readonly gti: number;
  readonly previousGti: number;
  readonly biomechanicalScore: number;
  readonly wearableScore: number;
  readonly matchPerformanceScore: number;
  readonly eliteBreached: boolean;
  readonly scoutAlertTriggered: boolean;
}

@Injectable()
export class GtiService {
  private readonly logger = new Logger(GtiService.name);

  // Weights specified in Kheleo Patent Architecture
  private static readonly W1_BIOMECHANICAL = 0.35;
  private static readonly W2_WEARABLE_CONSISTENCY = 0.25;
  private static readonly W3_MATCH_PERFORMANCE = 0.4;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly queueProducer: QueueProducerService,
    private readonly wsGateway: WsEventGateway,
  ) {}

  /**
   * Calculates Composite Grassroots Talent Index (GTI):
   * GTI = (w1 * BiomechanicalFormScore) + (w2 * WearableConsistencyScore) + (w3 * VerifiedMatchPerformance)
   * where w1 = 0.35, w2 = 0.25, w3 = 0.40
   */
  computeCompositeGti(
    biomechanicalScore: number,
    wearableScore: number,
    matchPerfScore: number,
  ): number {
    const rawGti =
      GtiService.W1_BIOMECHANICAL * biomechanicalScore +
      GtiService.W2_WEARABLE_CONSISTENCY * wearableScore +
      GtiService.W3_MATCH_PERFORMANCE * matchPerfScore;

    const normalized = Math.min(100.0, Math.max(0.0, rawGti));
    return Number(normalized.toFixed(2));
  }

  async recalculateAthleteGti(athleteId: string): Promise<GtiComputationResult> {
    // 1. Resolve athlete profile
    let profile = await this.prisma.athleteProfile.findUnique({
      where: { userId: athleteId },
      select: {
        id: true,
        userId: true,
        primarySport: true,
        district: true,
        state: true,
        tierClassification: true,
        isRuralOrUnderrepresented: true,
        biomechanicalScore: true,
        trainingConsistencyScore: true,
        matchPerformanceScore: true,
        wearableScore: true,
        matchPerfScore: true,
        gti: true,
        currentGti: true,
      },
    });

    if (!profile) {
      profile = await this.prisma.athleteProfile.findUnique({
        where: { id: athleteId },
        select: {
          id: true,
          userId: true,
          primarySport: true,
          district: true,
          state: true,
          tierClassification: true,
          isRuralOrUnderrepresented: true,
          biomechanicalScore: true,
          trainingConsistencyScore: true,
          matchPerformanceScore: true,
          wearableScore: true,
          matchPerfScore: true,
          gti: true,
          currentGti: true,
        },
      });
    }

    if (!profile) {
      throw new NotFoundException(`Athlete profile not found for ID: ${athleteId}`);
    }

    const targetUserId = profile.userId;
    const sport = String(profile.primarySport);
    const district = profile.district || 'UNKNOWN';

    // 2. Derive Component Scores
    // Biomechanical: from profile or recent drill submissions
    let biomech = profile.biomechanicalScore;
    if (biomech === 0) {
      const drills = await this.prisma.drillSubmission.findMany({
        where: { athleteId: targetUserId },
        select: { formScore: true },
        take: 20,
      });
      if (drills.length > 0) {
        const sum = drills.reduce((acc, d) => acc + d.formScore, 0);
        biomech = Number((sum / drills.length).toFixed(2));
      }
    }

    // Wearable Consistency: from trainingConsistencyScore or wearableScore
    const wearable =
      profile.trainingConsistencyScore > 0
        ? profile.trainingConsistencyScore
        : Number(profile.wearableScore) || 50.0;

    // Match Performance: from matchPerformanceScore or matchPerfScore
    const matchPerf =
      profile.matchPerformanceScore > 0
        ? profile.matchPerformanceScore
        : Number(profile.matchPerfScore) || 50.0;

    // 3. Compute normalized composite GTI
    const computedGti = this.computeCompositeGti(biomech, wearable, matchPerf);
    const previousGti = Number(profile.gti) || Number(profile.currentGti) || 0.0;
    const eliteBreached = computedGti >= 85.0;
    const isUnderrepresented =
      profile.isRuralOrUnderrepresented ||
      ['RURAL', 'TIER_3', 'TIER_2'].includes(String(profile.tierClassification));

    const scoutAlertCreated = await runSerializableTransaction(this.prisma, async (tx) => {
      await tx.athleteProfile.update({
        where: { id: profile.id },
        data: {
          gti: computedGti,
          currentGti: new Prisma.Decimal(computedGti),
          biomechanicalScore: biomech,
          trainingConsistencyScore: wearable,
          matchPerformanceScore: matchPerf,
        },
      });

      await tx.gtiHistory.create({
        data: {
          athleteId: profile.id,
          biomechanicalScore: new Prisma.Decimal(biomech),
          wearableScore: new Prisma.Decimal(wearable),
          matchScore: new Prisma.Decimal(matchPerf),
          compositeGti: new Prisma.Decimal(computedGti),
          calculationFactors: {
            w1: GtiService.W1_BIOMECHANICAL,
            w2: GtiService.W2_WEARABLE_CONSISTENCY,
            w3: GtiService.W3_MATCH_PERFORMANCE,
          },
        },
      });

      if (!eliteBreached || !isUnderrepresented) {
        return false;
      }

      const existingAlert = await tx.scoutAlert.findFirst({
        where: {
          athleteId: targetUserId,
          sport,
          isAcknowledged: false,
        },
        select: { id: true },
      });
      if (existingAlert) {
        return false;
      }

      await tx.scoutAlert.create({
        data: {
          athleteId: targetUserId,
          gtiScore: computedGti,
          district,
          sport,
          isAcknowledged: false,
        },
      });
      return true;
    });

    // 5. Update Redis Leaderboard ZSET for O(log N) retrieval
    try {
      const globalKey = `leaderboard:global:${sport}`;
      const districtKey = `leaderboard:district:${district}:${sport}`;

      await this.redisService.client.zadd(globalKey, computedGti, targetUserId);
      await this.redisService.client.zadd(districtKey, computedGti, targetUserId);
    } catch (err) {
      this.logger.warn(`Failed to update Redis leaderboard: ${String(err)}`);
    }

    // 6. Automated Scout Outreach Trigger
    if (scoutAlertCreated) {
      // Push to Scout Alerts queue
      await this.queueProducer.enqueueScoutAlert({
        athleteId: targetUserId,
        newGti: computedGti,
        sport,
        district,
        state: profile.state,
        tierClassification: String(profile.tierClassification),
      });

      // Broadcast realtime alert to scout dashboards
      if (this.wsGateway?.server) {
        this.wsGateway.server.to('scouts').emit('SCOUT_TALENT_ALERT', {
          athleteId: targetUserId,
          gtiScore: computedGti,
          sport,
          district,
          state: profile.state,
          tier: profile.tierClassification,
        });
      }

      this.logger.log(
        `AUTOMATED SCOUT ALERT FIRED: Hidden talent detected! Athlete=${targetUserId}, GTI=${computedGti}, District=${district}`,
      );
    }

    // Broadcast GTI updated to athlete socket room
    this.wsGateway.broadcastGtiUpdated({
      athleteId: targetUserId,
      previousGti,
      newGti: computedGti,
      eliteBreached,
    });

    return {
      athleteId: targetUserId,
      gti: computedGti,
      previousGti,
      biomechanicalScore: biomech,
      wearableScore: wearable,
      matchPerformanceScore: matchPerf,
      eliteBreached,
      scoutAlertTriggered: scoutAlertCreated,
    };
  }

  async getLeaderboardRank(
    sport: string,
    athleteId: string,
    district?: string,
  ): Promise<number | null> {
    try {
      const key = district
        ? `leaderboard:district:${district}:${sport}`
        : `leaderboard:global:${sport}`;
      const rank = await this.redisService.client.zrevrank(key, athleteId);
      return rank !== null ? rank + 1 : null;
    } catch {
      return null;
    }
  }
}
