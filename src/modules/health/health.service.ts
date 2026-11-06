import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/cache/redis.service';

import {
  QueueProducerService,
  QueueHealthStatus,
  monitoredQueueNames,
  unavailableQueue,
} from '../../infrastructure/queues/queue-producer.service';

type DependencyStatus = 'ok' | 'unavailable';

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly db: DependencyStatus;
  readonly redis: DependencyStatus;
  readonly uptime: number;
}

export interface OperatorHealthResponse {
  health: HealthResponse;
  dbLatencyMs: number | null;
  redisLatencyMs: number | null;
  postgisAvailable: boolean;
  postgisLatencyMs: number | null;
  bullmqQueuesStatus: QueueHealthStatus[];
  observedAt: string;
}
@Injectable()
export class HealthService {
  private static readonly TIMEOUT_MS = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() private readonly queues?: QueueProducerService,
  ) {}

  async check(): Promise<HealthResponse> {
    const [db, redis] = await Promise.all([
      this.checkDependency(() => this.prisma.$queryRaw`SELECT 1`),
      this.checkDependency(async () => {
        const reply = await this.redis.client.ping();
        if (reply !== 'PONG') {
          throw new Error('Unexpected Redis ping response.');
        }
      }),
    ]);

    return {
      status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      db,
      redis,
      uptime: process.uptime(),
    };
  }

  async diagnostics(): Promise<OperatorHealthResponse> {
    const measure = async (operation: () => Promise<unknown>): Promise<number | null> => {
      const started = performance.now();
      return (await this.checkDependency(operation)) === 'ok'
        ? Math.round((performance.now() - started) * 100) / 100
        : null;
    };
    const [dbLatencyMs, redisLatencyMs, postgisLatencyMs, bullmqQueuesStatus] = await Promise.all([
      measure(() => this.prisma.$queryRaw`SELECT 1`),
      measure(async () => {
        if ((await this.redis.client.ping()) !== 'PONG') throw new Error('Unexpected Redis reply');
      }),
      measure(async () => {
        const rows = await this.prisma.$queryRaw<
          Array<{ version: string }>
        >`SELECT PostGIS_Version() AS version`;
        if (!rows[0]?.version) throw new Error('PostGIS unavailable');
      }),
      this.queues?.healthStatuses() ?? Promise.resolve(monitoredQueueNames.map(unavailableQueue)),
    ]);
    return {
      dbLatencyMs,
      redisLatencyMs,
      postgisAvailable: postgisLatencyMs !== null,
      postgisLatencyMs,
      bullmqQueuesStatus,
      observedAt: new Date().toISOString(),
      health: {
        status:
          dbLatencyMs !== null &&
          redisLatencyMs !== null &&
          postgisLatencyMs !== null &&
          bullmqQueuesStatus.every((queue) => queue.status === 'ok')
            ? 'ok'
            : 'degraded',
        db: dbLatencyMs === null ? 'unavailable' : 'ok',
        redis: redisLatencyMs === null ? 'unavailable' : 'ok',
        uptime: process.uptime(),
      },
    };
  }

  private async checkDependency(operation: () => Promise<unknown>): Promise<DependencyStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Health check timed out.')),
        HealthService.TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([operation(), timeoutPromise]);
      return 'ok';
    } catch {
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  }
}
