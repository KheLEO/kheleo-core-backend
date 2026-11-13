import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { CACHE_KEYS, invalidateCacheKeys } from '../../infrastructure/cache/cache-helper';
import { SubmitDrillDto } from './dto/submit-drill.dto';
import { DrillSignatureVersion, Prisma } from '@prisma/client';
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
    @Optional() private readonly redis?: RedisService,
  ) {}

  async submitDrill(
    athleteId: string,
    dto: SubmitDrillDto,
    signatureHash: string,
    signatureVersion: DrillSignatureVersion = DrillSignatureVersion.LEGACY,
  ): Promise<DrillSubmissionResult> {
    const rawDigest = dto.joint_angles_summary?.client_pose_digest;
    const clientPoseDigest =
      typeof rawDigest === 'string' && /^[a-f\d]{64}$/.test(rawDigest) ? rawDigest : undefined;
    const posturePointsAwarded = Math.round(dto.form_score * 10);
    const currentBiomechanicalScore = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const profile = await transaction.athleteProfile.findUnique({
          where: { userId: athleteId },
          select: { id: true, userId: true, biomechanicalScore: true },
        });

        if (!profile) {
          throw new NotFoundException(`Athlete profile not found for user ${athleteId}.`);
        }

        const normalizedSignature = signatureHash.trim().toLowerCase();
        if (
          await transaction.drillSubmission.findFirst({
            where: {
              OR: [
                { signatureHash: normalizedSignature },
                ...(clientPoseDigest ? [{ athleteId, clientPoseDigest }] : []),
              ],
            },
            select: { id: true },
          })
        )
          throw new ConflictException('Drill signature or pose series was already submitted');
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
            signatureHash: signatureHash.trim().toLowerCase(),
            signatureVersion,
            clientPoseDigest,
            metadataVerified: signatureVersion !== DrillSignatureVersion.LEGACY,
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

    await invalidateCacheKeys(this.redis, [CACHE_KEYS.passport(athleteId)]);
    await this.queueProducer.enqueueGtiRecalculation({
      athleteId,
      trigger: 'DRILL_SUBMISSION',
    });

    this.logger.log(
      `Drill submitted for athlete ${athleteId}: formScore=${dto.form_score}, newBiomechanicalScore=${currentBiomechanicalScore}`,
    );

    return {
      success: true,
      posture_points_awarded: posturePointsAwarded,
      current_biomechanical_score: currentBiomechanicalScore,
    };
  }
}
