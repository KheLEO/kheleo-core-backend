import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
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
  readonly alertId?: string;
  readonly athleteId: string;
  readonly newGti: number;
  readonly sport: string;
  readonly district: string;
  readonly state: string;
  readonly tierClassification: string;
}

export interface QueueHealthStatus {
  name: string;
  status: 'ok' | 'paused' | 'unreachable';
  latencyMs: number | null;
  waiting: number | null;
  active: number | null;
  delayed: number | null;
  failed: number | null;
  completed: number | null;
}
export const monitoredQueueNames = [
  QUEUE_GTI_CALCULATION,
  QUEUE_MATCHMAKING,
  QUEUE_SCOUT_ALERTS,
] as const;
export function unavailableQueue(name: string): QueueHealthStatus {
  return {
    name,
    status: 'unreachable',
    latencyMs: null,
    waiting: null,
    active: null,
    delayed: null,
    failed: null,
    completed: null,
  };
}
@Injectable()
export class QueueProducerService {
  constructor(
    @InjectQueue(QUEUE_GTI_CALCULATION)
    private readonly gtiCalcQueue: Queue,
    @InjectQueue(QUEUE_MATCHMAKING)
    private readonly matchmakingQueue: Queue,
    @InjectQueue(QUEUE_SCOUT_ALERTS)
    private readonly scoutAlertQueue: Queue,
  ) {}

  async healthStatuses(): Promise<QueueHealthStatus[]> {
    return Promise.all(
      [this.gtiCalcQueue, this.matchmakingQueue, this.scoutAlertQueue].map(async (queue) => {
        const started = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const [counts, paused] = await Promise.race([
            Promise.all([
              queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
              queue.isPaused(),
            ]),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Queue health timed out')), 1000);
            }),
          ]);
          return {
            name: queue.name,
            status: paused ? ('paused' as const) : ('ok' as const),
            latencyMs: Math.round((performance.now() - started) * 100) / 100,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            completed: counts.completed ?? 0,
          };
        } catch {
          return unavailableQueue(queue.name);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }

  async enqueueGtiRecalculation(
    payload: GtiRecalculationPayload,
    deliveryId?: string,
  ): Promise<string> {
    const job = await this.gtiCalcQueue.add('recalculate', payload, {
      ...(deliveryId ? { jobId: deliveryId } : {}),
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });

    return job.id ?? '';
  }

  async enqueueBracketMatchmaking(
    payload: MatchmakingPayload,
    deliveryId?: string,
  ): Promise<string> {
    const job = await this.matchmakingQueue.add('process-bracket-pool', payload, {
      ...(deliveryId ? { jobId: deliveryId } : {}),
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return job.id ?? '';
  }

  async enqueueScoutAlert(payload: ScoutAlertPayload): Promise<string> {
    const job = await this.scoutAlertQueue.add('hidden-talent', payload, {
      ...(payload.alertId ? { jobId: `scout-${payload.alertId}` } : {}),
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
    return job.id ?? '';
  }
}
