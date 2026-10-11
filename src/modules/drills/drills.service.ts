import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { SubmitDrillDto } from './dto/submit-drill.dto';
import { Prisma } from '@prisma/client';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';

export interface DrillSubmissionResult {
  readonly success: boolean;
  readonly posture_points_awarded: number;
  readonly current_biomechanical_score: number;
}

@Injectable()
export class DrillsService {
  private readonly logger = new Logger(DrillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueProducer: QueueProducerService,
  ) {}

  async submitDrill(
    athleteId: string,
    dto: SubmitDrillDto,
    signatureHash: string,
  ): Promise<DrillSubmissionResult> {
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId: athleteId },
      select: { id: true, userId: true, biomechanicalScore: true },
    });

    if (!profile) {
      throw new NotFoundException(`Athlete profile not found for user ${athleteId}.`);
    }

    const posturePointsAwarded = Math.round(dto.form_score * 10);
    const currentBiomechanicalScore = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const previousSubmissionsCount = await transaction.drillSubmission.count({
          where: { athleteId: profile.userId },
        });
        const nextScore = Number(
          (
            (profile.biomechanicalScore * previousSubmissionsCount + dto.form_score) /
            (previousSubmissionsCount + 1)
          ).toFixed(2),
        );

        await transaction.drillSubmission.create({
          data: {
            athleteId: profile.userId,
            sport: dto.sport,
            drillType: dto.drill_type,
            formScore: dto.form_score,
            framesAnalyzed: dto.frames_analyzed,
            flawFlags: (dto.flaw_flags ?? []) as Prisma.InputJsonValue,
            jointAnglesSummary: (dto.joint_angles_summary ?? {}) as Prisma.InputJsonValue,
            signatureHash,
          },
        });

        await transaction.athleteProfile.update({
          where: { id: profile.id },
          data: {
            biomechanicalScore: nextScore,
            posturePoints: { increment: posturePointsAwarded },
          },
        });
        return nextScore;
      },
    );

    // 5. Enqueue GTI recalculation BullMQ job
    await this.queueProducer.enqueueGtiRecalculation({
      athleteId: profile.userId,
      trigger: 'DRILL_SUBMISSION',
    });

    this.logger.log(
      `Drill submitted for athlete ${profile.userId}: formScore=${dto.form_score}, newBiomechanicalScore=${currentBiomechanicalScore}`,
    );

    return {
      success: true,
      posture_points_awarded: posturePointsAwarded,
      current_biomechanical_score: currentBiomechanicalScore,
    };
  }
}
