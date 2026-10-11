import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { SubmitDrillDto } from './dto/submit-drill.dto';
import { Prisma } from '@prisma/client';

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
    // 1. Resolve athlete profile by userId or profile id
    let profile = await this.prisma.athleteProfile.findUnique({
      where: { userId: athleteId },
    });

    let userId = athleteId;
    if (!profile) {
      // Check if athleteId was profile.id
      profile = await this.prisma.athleteProfile.findUnique({
        where: { id: athleteId },
      });
      if (profile) {
        userId = profile.userId;
      }
    }

    // 2. Count existing submissions for cumulative running average
    const previousSubmissionsCount = await this.prisma.drillSubmission.count({
      where: { athleteId: userId },
    });

    const previousBiomechanicalScore = profile?.biomechanicalScore ?? dto.form_score;
    const currentBiomechanicalScore = Number(
      (
        (previousBiomechanicalScore * previousSubmissionsCount + dto.form_score) /
        (previousSubmissionsCount + 1)
      ).toFixed(2),
    );

    const posturePointsAwarded = Math.round(dto.form_score * 10);

    // 3. Persist DrillSubmission record
    await this.prisma.drillSubmission.create({
      data: {
        athleteId: userId,
        sport: dto.sport,
        drillType: dto.drill_type,
        formScore: dto.form_score,
        framesAnalyzed: dto.frames_analyzed,
        flawFlags: (dto.flaw_flags ?? []) as Prisma.InputJsonValue,
        jointAnglesSummary: (dto.joint_angles_summary ?? {}) as Prisma.InputJsonValue,
        signatureHash,
      },
    });

    // 4. Update AthleteProfile biomechanical score and posture points
    if (profile) {
      await this.prisma.athleteProfile.update({
        where: { id: profile.id },
        data: {
          biomechanicalScore: currentBiomechanicalScore,
          posturePoints: { increment: posturePointsAwarded },
        },
      });
    }

    // 5. Enqueue GTI recalculation BullMQ job
    await this.queueProducer.enqueueGtiRecalculation({
      athleteId: userId,
      trigger: 'DRILL_SUBMISSION',
    });

    this.logger.log(
      `Drill submitted for athlete ${userId}: formScore=${dto.form_score}, newBiomechanicalScore=${currentBiomechanicalScore}`,
    );

    return {
      success: true,
      posture_points_awarded: posturePointsAwarded,
      current_biomechanical_score: currentBiomechanicalScore,
    };
  }
}
