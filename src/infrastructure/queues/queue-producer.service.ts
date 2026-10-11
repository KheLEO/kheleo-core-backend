import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  QUEUE_GTI_RECALCULATION,
  QUEUE_GTI_CALCULATION,
  QUEUE_MATCHMAKING,
  QUEUE_SCOUT_ALERTS,
} from '../../common/constants/queue.constants';

export interface GtiRecalculationPayload {
  readonly athleteId: string;
  readonly trigger: 'DRILL_SUBMISSION' | 'MATCH_COMPLETED' | 'WEARABLE_SYNC' | 'MANUAL';
}

export interface MatchmakingPayload {
  readonly tournamentId: string;
  readonly bracketId?: string;
}

export interface ScoutAlertPayload {
  readonly athleteId: string;
  readonly newGti: number;
  readonly sport: string;
  readonly district: string;
  readonly state: string;
  readonly tierClassification: string;
}

@Injectable()
export class QueueProducerService {
  constructor(
    @InjectQueue(QUEUE_GTI_RECALCULATION)
    private readonly gtiQueue: Queue,
    @InjectQueue(QUEUE_GTI_CALCULATION)
    private readonly gtiCalcQueue: Queue,
    @InjectQueue(QUEUE_MATCHMAKING)
    private readonly matchmakingQueue: Queue,
    @InjectQueue(QUEUE_SCOUT_ALERTS)
    private readonly scoutAlertQueue: Queue,
  ) {}

  async enqueueGtiRecalculation(
    payload: GtiRecalculationPayload,
  ): Promise<string> {
    const job = await this.gtiQueue.add('recalculate', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    // Also push to gtiCalcQueue for any processor listening on gti-calculation
    await this.gtiCalcQueue.add('recalculate', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    }).catch(() => null);

    return job.id ?? '';
  }

  async enqueueGtiCalculation(
    payload: GtiRecalculationPayload,
  ): Promise<string> {
    return this.enqueueGtiRecalculation(payload);
  }

  async enqueueMatchmaking(payload: MatchmakingPayload): Promise<string> {
    const job = await this.matchmakingQueue.add('balance-teams', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    });
    return job.id ?? '';
  }

  async enqueueBracketMatchmaking(payload: MatchmakingPayload): Promise<string> {
    const job = await this.matchmakingQueue.add('process-bracket-pool', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return job.id ?? '';
  }

  async enqueueScoutAlert(payload: ScoutAlertPayload): Promise<string> {
    const job = await this.scoutAlertQueue.add('hidden-talent', payload, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
    return job.id ?? '';
  }
}
