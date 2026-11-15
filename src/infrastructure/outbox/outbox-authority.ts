import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { OutboxEvent, Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';

export const OUTBOX_WAKEUP_CHANNEL = 'kheleo:outbox:wakeup';

/**
 * Shared in-process wakeup signal so transactions committing on this replica
 * notify an embedded OutboxDispatcher immediately without polling wait.
 */
export const outboxWakeupBus = new EventEmitter();
outboxWakeupBus.setMaxListeners(50);

const transactionIntents = new WeakMap<object, OutboxEvent[]>();
let publishWakeup: (() => Promise<unknown>) | undefined;

export function registerOutboxWakeupPublisher(publisher: () => Promise<unknown>): void {
  publishWakeup = publisher;
}

export function signalOutboxWakeup(): void {
  outboxWakeupBus.emit('wakeup');
  try {
    void publishWakeup?.().catch(() => {});
  } catch {
    // Durable polling remains the fallback even if the publisher throws synchronously.
  }
}

/** Capture only rows inserted by this transaction, before any dispatcher can claim them. */
export async function captureOutboxIntents<T>(tx: Prisma.TransactionClient, value: T): Promise<T> {
  if (!tx.outboxEvent || typeof tx.$queryRaw !== 'function') return value;
  const events = await tx.$queryRaw<OutboxEvent[]>(Prisma.sql`
    SELECT id,kind,payload,attempts,available_at AS "availableAt",locked_until AS "lockedUntil",
      locked_by AS "lockedBy",delivered_at AS "deliveredAt",last_error AS "lastError",created_at AS "createdAt"
    FROM outbox_events WHERE xmin=pg_current_xact_id()::xid AND delivered_at IS NULL ORDER BY created_at,id`);
  if (value !== null && typeof value === 'object') transactionIntents.set(value, events);
  return value;
}

export function outboxDeliveryId(event: OutboxEvent): string {
  const payload = event.payload as Prisma.JsonObject;
  return typeof payload.deliveryId === 'string' ? payload.deliveryId : event.id;
}

/** PostgreSQL canonicalizes UUIDs; incoming DTOs may use uppercase hex characters. */
export function outboxIdMatches(value: unknown, id: string | undefined): boolean {
  return (
    typeof value === 'string' && typeof id === 'string' && value.toLowerCase() === id.toLowerCase()
  );
}

/** Both the immediate service path and the dispatcher compete for the same durable row lease. */
export async function deliverDirectOutbox(
  prisma: PrismaService,
  result: unknown,
  kind: string,
  matches: (payload: Prisma.JsonObject) => boolean,
  deliver: (event?: OutboxEvent) => unknown | Promise<unknown>,
): Promise<void> {
  const events =
    result !== null && typeof result === 'object'
      ? (transactionIntents
          .get(result)
          ?.filter((event) => event.kind === kind && matches(event.payload as Prisma.JsonObject)) ??
        [])
      : [];
  if (events.length === 0) {
    await deliver();
    return;
  }
  for (const event of events) {
    const owner = randomUUID();
    const claimed = await prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        deliveredAt: null,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
      },
      data: { lockedBy: owner, lockedUntil: new Date(Date.now() + 30_000) },
    });
    if (claimed.count !== 1) continue; // Already delivered or claimed by a dispatcher.
    try {
      const delivered = await deliver(event);
      if (delivered === false) throw new Error('Outbox delivery did not reach a transport');
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: owner },
        data: {
          deliveredAt: new Date(),
          lockedBy: null,
          lockedUntil: null,
          lastError: null,
          attempts: { increment: 1 },
        },
      });
    } catch (error: unknown) {
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: owner },
        data: {
          lockedBy: null,
          lockedUntil: null,
          lastError: String(error).slice(0, 500),
          attempts: { increment: 1 },
        },
      });
      signalOutboxWakeup();
      throw error;
    }
  }
}
