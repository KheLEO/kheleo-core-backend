import { EventEmitter } from 'node:events';

export const OUTBOX_WAKEUP_CHANNEL = 'kheleo:outbox:wakeup';

/**
 * Shared in-process wakeup signal so transactions committing on this replica
 * notify an embedded OutboxDispatcher immediately without polling wait.
 */
export const outboxWakeupBus = new EventEmitter();
outboxWakeupBus.setMaxListeners(50);
