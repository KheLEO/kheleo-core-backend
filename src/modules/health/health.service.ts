import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/cache/redis.service';

type DependencyStatus = 'ok' | 'unavailable';

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly db: DependencyStatus;
  readonly redis: DependencyStatus;
  readonly uptime: number;
}

@Injectable()
export class HealthService {
  private static readonly TIMEOUT_MS = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
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
