import { Prisma } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  captureOutboxIntents,
  signalOutboxWakeup,
} from '../../infrastructure/outbox/outbox-authority';

const MAX_TRANSACTION_ATTEMPTS = 8;

export async function runSerializableTransaction<TResult>(
  prisma: PrismaService,
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>,
): Promise<TResult> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      const result = await prisma.$transaction(
        async (tx) => captureOutboxIntents(tx, await operation(tx)),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
      signalOutboxWakeup();
      return result;
    } catch (error: unknown) {
      const isRetryableConflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';

      if (!isRetryableConflict || attempt === MAX_TRANSACTION_ATTEMPTS) {
        throw error;
      }
      // Yield to competing GTI workers instead of exhausting retries against the same row lock.
      await delay(Math.min(250, 20 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 20));
    }
  }

  throw new Error('Serializable transaction retry limit exhausted.');
}
