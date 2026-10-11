import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_MATCHMAKING } from '../../../common/constants/queue.constants';
import { MatchmakingService } from '../matchmaking.service';
import { MatchmakingPayload } from '../../../infrastructure/queues/queue-producer.service';

@Processor(QUEUE_MATCHMAKING)
export class MatchmakingProcessor extends WorkerHost {
  private readonly logger = new Logger(MatchmakingProcessor.name);

  constructor(private readonly matchmakingService: MatchmakingService) {
    super();
  }

  async process(job: Job<MatchmakingPayload, boolean, string>): Promise<boolean> {
    this.logger.log(
      `Processing Matchmaking Job [${job.name}] ID: ${job.id} for Tournament: ${job.data.tournamentId}, Bracket: ${job.data.bracketId}`,
    );

    const { tournamentId, bracketId } = job.data;

    if (!bracketId) {
      this.logger.warn(`Job ${job.id} missing bracketId, skipping.`);
      return false;
    }

    try {
      const teamFormed = await this.matchmakingService.processBracketPool(
        tournamentId,
        bracketId,
      );

      if (teamFormed) {
        this.logger.log(
          `Successfully formed complementary team in Bracket ${bracketId}`,
        );
      } else {
        this.logger.debug(
          `No team formed in this cycle for Bracket ${bracketId}. Waiting for queue pool growth.`,
        );
      }

      return teamFormed;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Matchmaking processor failed for Bracket ${bracketId}: ${errorMsg}`,
      );
      throw err;
    }
  }
}
