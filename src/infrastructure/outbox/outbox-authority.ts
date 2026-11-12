import { EventEmitter } from 'node:events';

export const OUTBOX_WAKEUP_CHANNEL = 'kheleo:outbox:wakeup';

/**
 * Shared in-process wakeup signal so transactions committing on this replica
 * notify an embedded OutboxDispatcher immediately without polling wait.
 */
export const outboxWakeupBus = new EventEmitter();
outboxWakeupBus.setMaxListeners(50);

/**
 * Returns true when this Prisma instance connects to PostgreSQL with transactional
 * `capture_delivery_intent()` triggers writing `outbox_events`.
 * In-memory unit-test fixtures that omit `outboxEvent` return false so service-level
 * unit tests continue exercising injected queue/socket/leaderboard mocks directly.
 */
export function hasTransactionalOutboxTriggers(prisma: unknown): boolean {
  if (process.env.DISABLE_TRANSACTIONAL_OUTBOX === 'true') {
    return false;
  }
  const candidate = prisma as { outboxEvent?: unknown } | null | undefined;
  return Boolean(candidate && typeof candidate.outboxEvent === 'object');
}

export function notifyOutboxSubscribers(
  redis?: { client?: { publish?: (channel: string, message: string) => Promise<unknown> } },
  kind = 'EVENT',
): void {
  outboxWakeupBus.emit('wakeup', kind);
  if (typeof redis?.client?.publish === 'function') {
    void redis.client.publish(OUTBOX_WAKEUP_CHANNEL, kind).catch(() => undefined);
  }
}

