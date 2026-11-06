import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { OutboxEvent, Prisma, SportType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { QueueProducerService, GtiRecalculationPayload } from '../queues/queue-producer.service';
import { WsEventGateway } from '../realtime/ws-event.gateway';
import { WsAuthGuard } from '../realtime/ws-auth.guard';
import { MatchmakingGateway } from '../../modules/matchmaking/matchmaking.gateway';
import { LeaderboardsService } from '../../modules/leaderboards/leaderboards.service';

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
@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueProducerService,
    private readonly ws: WsEventGateway,
    private readonly matchmaking: MatchmakingGateway,
    private readonly leaderboards: LeaderboardsService,
    private readonly sockets: WsAuthGuard,
  ) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.start(), 1000);
    this.timer.unref();
    this.start();
  }
  private start(): void {
    if (this.stopped || this.running) return;
    this.running = this.dispatchOnce()
      .catch((error: unknown) => this.logger.error(`Outbox dispatch failed: ${String(error)}`))
      .finally(() => {
        this.running = undefined;
      });
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
  async dispatchOnce(): Promise<void> {
    const owner = randomUUID();
    const events = await this.prisma.$queryRaw<OutboxEvent[]>(Prisma.sql`
      WITH pending AS (
        SELECT id FROM outbox_events WHERE delivered_at IS NULL AND available_at<=now()
        AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 10
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
      case 'GTI_UPDATED':
        this.ws.broadcastGtiUpdated({
          eventId: event.id,
          athleteId: str(data, 'athleteId'),
          previousGti: num(data, 'previousGti'),
          newGti: num(data, 'newGti'),
          eliteBreached: data.eliteBreached === true,
        });
        return;
      case 'LEADERBOARD': {
        const previous = data.previous ? object(data.previous) : undefined;
        const sport = previous?.primarySport;
        await this.leaderboards.syncAthlete(
          str(data, 'athleteId'),
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
        return;
      }
      case 'REVOKE_SOCKETS':
        this.sockets.disconnectUser(str(data, 'athleteId'));
        return;
      default:
        throw new Error(`Unknown outbox kind ${event.kind}`);
    }
  }
}
