import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_MATCHMAKING } from '../../../common/constants/queue.constants';
import { MatchmakingService } from '../matchmaking.service';
import { MatchmakingPayload } from '../../../infrastructure/queues/queue-producer.service';

@Processor(QUEUE_MATCHMAKING, { concurrency: 2 })
export class MatchmakingProcessor extends WorkerHost {
  private readonly logger = new Logger(MatchmakingProcessor.name);

  constructor(private readonly matchmakingService: MatchmakingService) {
    super();
  }

  async process(job: Job<MatchmakingPayload, boolean, string>): Promise<boolean> {
    const started = performance.now();
    const { tournamentId, bracketId } = job.data;

    if (!bracketId) {
      this.logger.warn(`Job ${job.id} missing bracketId, skipping.`);
      return false;
    }

    try {
      const teamFormed = await this.matchmakingService.processBracketPool(tournamentId, bracketId);
      const durationMs = Math.round((performance.now() - started) * 100) / 100;

      if (teamFormed) {
        this.logger.log(
          `Matchmaking job ${job.id ?? 'inline'} formed roster in Bracket=${bracketId} in ${durationMs}ms`,
        );
      } else {
        this.logger.debug(
          `No team formed in Bracket=${bracketId} (${durationMs}ms). Waiting for queue pool growth.`,
        );
      }

      return teamFormed;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Matchmaking processor failed for Bracket ${bracketId}: ${errorMsg}`);
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<MatchmakingPayload> | undefined, error: Error): void {
    if (!job) return;
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `DLQ_ALERT queue=${QUEUE_MATCHMAKING} jobId=${job.id} bracketId=${job.data?.bracketId} attempts=${job.attemptsMade}: ${error.message}`,
      );
    }
  }
}
