import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_GTI_RECALCULATION } from '../../../common/constants/queue.constants';
import { GtiService } from '../gti.service';
import { GtiRecalculationPayload } from '../../../infrastructure/queues/queue-producer.service';

@Processor(QUEUE_GTI_RECALCULATION)
export class GtiRecalculationProcessor extends WorkerHost {
  private readonly logger = new Logger(GtiRecalculationProcessor.name);

  constructor(private readonly gtiService: GtiService) {
    super();
  }

  async process(job: Job<GtiRecalculationPayload>): Promise<boolean> {
    const { athleteId, trigger } = job.data;

    this.logger.log(
      `Processing GTI Recalculation Job [${job.name}] for Athlete: ${athleteId}, Trigger: ${trigger}`,
    );

    try {
      const result = await this.gtiService.recalculateAthleteGti(athleteId);
      this.logger.log(
        `GTI calculated successfully for Athlete ${athleteId}: New GTI = ${result.gti} (Prev = ${result.previousGti})`,
      );
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`GTI calculation job failed for Athlete ${athleteId}: ${msg}`);
      throw err;
    }
  }
}
