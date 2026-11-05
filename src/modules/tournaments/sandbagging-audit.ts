import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
export async function recordSandbaggingRejection(
  prisma: PrismaService,
  error: unknown,
  tournamentId: string,
  bracketId: string,
  userId: string,
): Promise<void> {
  if (!(error instanceof ConflictException)) return;
  const response = error.getResponse();
  if (
    typeof response !== 'object' ||
    !('code' in response) ||
    response.code !== 'SANDBAGGING_DETECTED'
  )
    return;
  await prisma.securityAuditLog.create({
    data: {
      userId,
      action: 'SANDBAGGING_DETECTED',
      resource: 'tournament',
      resourceId: tournamentId,
      metadata: { ...response, bracketId } as Prisma.InputJsonObject,
    },
  });
}
