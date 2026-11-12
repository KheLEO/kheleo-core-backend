import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_GTI_CALCULATION } from '../../../common/constants/queue.constants';
import { GtiService } from '../gti.service';
import { GtiRecalculationPayload } from '../../../infrastructure/queues/queue-producer.service';

@Processor(QUEUE_GTI_CALCULATION, { concurrency: 5 })
export class GtiCalculationProcessor extends WorkerHost {
  private readonly logger = new Logger(GtiCalculationProcessor.name);

  constructor(private readonly gtiService: GtiService) {
    super();
  }

  async process(job: Job<GtiRecalculationPayload>): Promise<boolean> {
    const started = performance.now();
    const { athleteId, trigger } = job.data;

    try {
      const result = await this.gtiService.recalculateAthleteGti(athleteId, trigger);
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      this.logger.log(
        `GTI job ${job.id ?? 'inline'} calculated Athlete=${athleteId} GTI=${result.gti} in ${durationMs}ms`,
      );
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`GTI calculation job failed for Athlete ${athleteId}: ${msg}`);
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<GtiRecalculationPayload> | undefined, error: Error): void {
    if (!job) return;
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `DLQ_ALERT queue=${QUEUE_GTI_CALCULATION} jobId=${job.id} athleteId=${job.data?.athleteId} attempts=${job.attemptsMade}: ${error.message}`,
      );
    }
  }
}
