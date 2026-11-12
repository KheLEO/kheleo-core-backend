import {
  Injectable,
  Logger,
  Optional,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { OutboxEvent, Prisma, SportType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { QueueProducerService, GtiRecalculationPayload } from '../queues/queue-producer.service';
import { WsEventGateway } from '../realtime/ws-event.gateway';
import { WsAuthGuard } from '../realtime/ws-auth.guard';
import { MatchmakingGateway } from '../../modules/matchmaking/matchmaking.gateway';
import { LeaderboardsService } from '../../modules/leaderboards/leaderboards.service';
import { RedisService } from '../cache/redis.service';
import { OUTBOX_WAKEUP_CHANNEL, outboxWakeupBus } from './outbox-authority';
import {
  CACHE_KEYS,
  invalidateAuthAndPassport,
  invalidateCacheKeys,
} from '../cache/cache-helper';

type JsonObject = Prisma.JsonObject;
function object(value: Prisma.JsonValue): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Outbox payload must be an object');
  return value;
}
function str(value: JsonObject, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result) throw new Error(`Invalid outbox ${key}`);
  return result;
}
function num(value: JsonObject, key: string): number {
  const result = value[key];
  if (typeof result !== 'number' || !Number.isFinite(result))
    throw new Error(`Invalid outbox ${key}`);
  return result;
}

const OUTBOX_BATCH_SIZE = 25;
const MIN_IDLE_POLL_MS = 1000;
const MAX_IDLE_POLL_MS = 30000;
const BURST_DRAIN_POLL_MS = 25;
const CLEANUP_INTERVAL_MS = 3600_000;

@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private subscriber?: Redis;
  private currentIdlePollMs = MIN_IDLE_POLL_MS;
  private lastDispatchedCount = 0;
  private lastCleanupAt = 0;
  private pendingWakeup = false;
  private readonly onLocalWakeup = (): void => {
    this.wakeUp();
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueProducerService,
    private readonly ws: WsEventGateway,
    private readonly matchmaking: MatchmakingGateway,
    private readonly leaderboards: LeaderboardsService,
    private readonly sockets: WsAuthGuard,
    @Optional() private readonly redis?: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    outboxWakeupBus.on('wakeup', this.onLocalWakeup);
    this.attachRedisWakeupSubscriber();
    this.scheduleNext(0);
  }

  private attachRedisWakeupSubscriber(): void {
    const client = this.redis?.client;
    if (!client || typeof client.duplicate !== 'function') return;
    try {
      const sub = client.duplicate({ lazyConnect: true, enableOfflineQueue: true });
      sub.on('error', (error: unknown) => {
        this.logger.warn(`Outbox wakeup subscriber error (polling fallback active): ${String(error)}`);
      });
      sub.on('message', (channel: string) => {
        if (channel === OUTBOX_WAKEUP_CHANNEL) {
          this.wakeUp();
        }
      });
      void sub
        .connect()
        .then(() => sub.subscribe(OUTBOX_WAKEUP_CHANNEL))
        .catch((error: unknown) => {
          this.logger.warn(
            `Outbox wakeup Redis subscription unavailable (using adaptive polling fallback): ${String(error)}`,
          );
        });
      this.subscriber = sub;
    } catch (error: unknown) {
      this.logger.warn(`Could not initialize outbox Redis wakeup listener: ${String(error)}`);
    }
  }

  /**
   * Triggers an immediate dispatch cycle (or coalesces a rerun if one is in flight)
   * and resets idle backoff.
   */
  wakeUp(): void {
    if (this.stopped) return;
    this.currentIdlePollMs = MIN_IDLE_POLL_MS;
    if (this.running) {
      this.pendingWakeup = true;
      return;
    }
    this.scheduleNext(0);
  }

  getPollState(): { readonly currentIdlePollMs: number; readonly lastDispatchedCount: number } {
    return {
      currentIdlePollMs: this.currentIdlePollMs,
      lastDispatchedCount: this.lastDispatchedCount,
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private start(): void {
    if (this.stopped || this.running) return;
    this.pendingWakeup = false;
    this.running = this.dispatchBatch()
      .then(async (count) => {
        this.lastDispatchedCount = count;
        if (count >= OUTBOX_BATCH_SIZE) {
          this.currentIdlePollMs = MIN_IDLE_POLL_MS;
          this.scheduleNext(BURST_DRAIN_POLL_MS);
          return;
        }
        if (count > 0) {
          this.currentIdlePollMs = MIN_IDLE_POLL_MS;
        } else {
          this.currentIdlePollMs = Math.min(MAX_IDLE_POLL_MS, this.currentIdlePollMs * 2);
        }
        await this.maybeCleanupDeliveredEvents();
        this.scheduleNext(this.pendingWakeup ? 0 : this.currentIdlePollMs);
      })
      .catch((error: unknown) => {
        this.logger.error(`Outbox dispatch failed: ${String(error)}`);
        this.scheduleNext(this.currentIdlePollMs);
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    outboxWakeupBus.off('wakeup', this.onLocalWakeup);
    clearTimeout(this.timer);
    await this.running;
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        this.subscriber.disconnect();
      }
      this.subscriber = undefined;
    }
  }

  async dispatchOnce(): Promise<void> {
    this.lastDispatchedCount = await this.dispatchBatch();
  }

  private async maybeCleanupDeliveredEvents(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    try {
      await this.pruneDeliveredEvents(7, 500);
    } catch (error: unknown) {
      this.logger.warn(`Outbox delivered-row pruning skipped: ${String(error)}`);
    }
  }

  async pruneDeliveredEvents(retentionDays = 7, batchSize = 500): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const result = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH stale AS (
        SELECT id FROM outbox_events
        WHERE delivered_at IS NOT NULL AND delivered_at < ${cutoff}
        LIMIT ${batchSize}
      )
      DELETE FROM outbox_events o
      USING stale
      WHERE o.id = stale.id
      RETURNING o.id`);
    return result.length;
  }

  private async dispatchBatch(): Promise<number> {
    const owner = randomUUID();
    const events = await this.prisma.$queryRaw<OutboxEvent[]>(Prisma.sql`
      WITH pending AS (
        SELECT id FROM outbox_events WHERE delivered_at IS NULL AND available_at<=now()
        AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT ${OUTBOX_BATCH_SIZE}
      ) UPDATE outbox_events o SET locked_by=${owner}::uuid,locked_until=now()+interval '30 seconds'
      FROM pending WHERE o.id=pending.id
      RETURNING o.id,o.kind,o.payload,o.attempts,o.available_at AS "availableAt",o.locked_until AS "lockedUntil",o.locked_by AS "lockedBy",o.delivered_at AS "deliveredAt",o.last_error AS "lastError",o.created_at AS "createdAt"`);
    await Promise.all(
      events.map(async (event) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.publish(event),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Delivery timed out')), 5000);
            }),
          ]);
          await this.prisma.outboxEvent.updateMany({
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
          await this.prisma.outboxEvent.updateMany({
            where: { id: event.id, lockedBy: owner },
            data: {
              attempts: { increment: 1 },
              lockedBy: null,
              lockedUntil: null,
              availableAt: new Date(
                Date.now() + Math.min(300000, 1000 * 2 ** Math.min(event.attempts, 8)),
              ),
              lastError: String(error).slice(0, 500),
            },
          });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return events.length;
  }

  private async publish(event: OutboxEvent): Promise<void> {
    const data = object(event.payload);
    const deliveryId = typeof data.deliveryId === 'string' ? data.deliveryId : event.id;
    switch (event.kind) {
      case 'GTI': {
        const trigger = str(data, 'trigger');
        if (!['DRILL_SUBMISSION', 'WEARABLE_SYNC', 'MATCH_COMPLETED', 'MANUAL'].includes(trigger))
          throw new Error('Invalid GTI trigger');
        await this.queue.enqueueGtiRecalculation(
          {
            athleteId: str(data, 'athleteId'),
            trigger: trigger as GtiRecalculationPayload['trigger'],
          },
          deliveryId,
        );
        return;
      }
      case 'MATCHMAKING':
        await this.queue.enqueueBracketMatchmaking(
          { tournamentId: str(data, 'tournamentId'), bracketId: str(data, 'bracketId') },
          deliveryId,
        );
        return;
      case 'SCOUT':
        await this.queue.enqueueScoutAlert({
          alertId: str(data, 'alertId'),
          athleteId: str(data, 'athleteId'),
          newGti: num(data, 'newGti'),
          sport: str(data, 'sport'),
          district: str(data, 'district'),
          state: str(data, 'state'),
          tierClassification: str(data, 'tierClassification'),
        });
        return;
      case 'ROSTER': {
        if (!Array.isArray(data.roster)) throw new Error('Invalid roster');
        this.matchmaking.emitRosterFormed(
          {
            team_id: str(data, 'team_id'),
            team_name: str(data, 'team_name'),
            bracket_id: str(data, 'bracket_id'),
            roster: data.roster.map((value) => {
              const member = object(value);
              return {
                user_id: str(member, 'user_id'),
                name: str(member, 'name'),
                assigned_role: str(member, 'assigned_role'),
                gti: num(member, 'gti'),
              };
            }),
          },
          event.id,
        );
        return;
      }
      case 'PAUSE': {
        const vitals = object(data.vitals ?? null);
        this.ws.broadcastAutonomousMatchPause({
          event_id: event.id,
          ...(typeof data.alert_id === 'string' ? { alert_id: data.alert_id } : {}),
          ...(typeof data.source === 'string' ? { source: data.source } : {}),
          ...(Array.isArray(data.baseline_fields)
            ? {
                baseline_fields: data.baseline_fields.filter(
                  (field): field is string => typeof field === 'string',
                ),
              }
            : {}),
          event: 'MATCH_PAUSE_ALERT',
          severity: 'CRITICAL',
          athlete_id: str(data, 'athlete_id'),
          athlete_name: str(data, 'athlete_name'),
          directive: str(data, 'directive'),
          match_id: str(data, 'match_id'),
          bracket_id: str(data, 'bracket_id'),
          tournament_id: str(data, 'tournament_id'),
          vitals: {
            heart_rate: num(vitals, 'heart_rate'),
            spo2: num(vitals, 'spo2'),
            skin_temperature: num(vitals, 'skin_temperature'),
          },
        });
        return;
      }
      case 'GTI_UPDATED': {
        const athleteId = str(data, 'athleteId');
        await invalidateCacheKeys(this.redis, [
          CACHE_KEYS.passport(athleteId),
          CACHE_KEYS.regionalHeatmap(),
        ]);
        this.ws.broadcastGtiUpdated({
          eventId: event.id,
          athleteId,
          previousGti: num(data, 'previousGti'),
          newGti: num(data, 'newGti'),
          eliteBreached: data.eliteBreached === true,
        });
        return;
      }
      case 'LEADERBOARD': {
        const athleteId = str(data, 'athleteId');
        const previous = data.previous ? object(data.previous) : undefined;
        const sport = previous?.primarySport;
        await this.leaderboards.syncAthlete(
          athleteId,
          previous
            ? {
                primarySport: Object.values(SportType).some((value) => value === sport)
                  ? (sport as SportType)
                  : null,
                state: typeof previous.state === 'string' ? previous.state : '',
                district: typeof previous.district === 'string' ? previous.district : '',
              }
            : undefined,
          true,
        );
        await invalidateCacheKeys(this.redis, [
          CACHE_KEYS.passport(athleteId),
          CACHE_KEYS.regionalHeatmap(),
        ]);
        return;
      }
      case 'REVOKE_SOCKETS': {
        const athleteId = str(data, 'athleteId');
        await invalidateAuthAndPassport(this.redis, athleteId);
        this.sockets.disconnectUser(athleteId);
        return;
      }
      default:
        throw new Error(`Unknown outbox kind ${event.kind}`);
    }
  }
}
