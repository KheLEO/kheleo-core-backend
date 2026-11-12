import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_SCOUT_ALERTS } from '../../../common/constants/queue.constants';
import { ScoutAlertPayload } from '../../../infrastructure/queues/queue-producer.service';
import { WsEventGateway } from '../../../infrastructure/realtime/ws-event.gateway';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

@Processor(QUEUE_SCOUT_ALERTS, { concurrency: 4 })
export class ScoutAlertsProcessor extends WorkerHost {
  private readonly logger = new Logger(ScoutAlertsProcessor.name);

  constructor(
    private readonly ws: WsEventGateway,
    private readonly prisma: PrismaService,
  ) {
    super();
  }
  async process(job: Job<ScoutAlertPayload>): Promise<boolean> {
    if (job.data.alertId) {
      const alert = await this.prisma.scoutAlert.findUnique({ where: { id: job.data.alertId } });
      if (!alert || alert.isAcknowledged || alert.athleteId !== job.data.athleteId) return false;
    }
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId: job.data.athleteId },
      include: { user: { include: { identityRecord: true } } },
    });
    if (
      !profile ||
      !profile.isScoutSearchable ||
      !profile.user.isActive ||
      profile.user.role !== 'ATHLETE' ||
      profile.user.identityRecord?.status !== 'VERIFIED' ||
      !profile.primarySport ||
      profile.gti < 85
    )
      return false;
    this.ws.broadcastScoutTalent({
      ...job.data,
      newGti: profile.gti,
      sport: profile.primarySport,
      state: profile.state,
      district: profile.district,
      tierClassification: profile.tierClassification,
    });
    return true;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ScoutAlertPayload> | undefined, error: Error): void {
    if (!job) return;
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `DLQ_ALERT queue=${QUEUE_SCOUT_ALERTS} jobId=${job.id} alertId=${job.data?.alertId} attempts=${job.attemptsMade}: ${error.message}`,
      );
    }
  }
}
