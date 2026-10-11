import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

const MAX_TRANSACTION_ATTEMPTS = 3;

export async function runSerializableTransaction<TResult>(
  prisma: PrismaService,
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>,
): Promise<TResult> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error: unknown) {
      const isRetryableConflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';

      if (!isRetryableConflict || attempt === MAX_TRANSACTION_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw new Error('Serializable transaction retry limit exhausted.');
}
