import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { Prisma, SportType } from '@prisma/client';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { QueueProducerService } from '../src/infrastructure/queues/queue-producer.service';
import { WsEventGateway } from '../src/infrastructure/realtime/ws-event.gateway';
import { MatchmakingGateway } from '../src/modules/matchmaking/matchmaking.gateway';
import { LeaderboardsService } from '../src/modules/leaderboards/leaderboards.service';
import { WsAuthGuard } from '../src/infrastructure/realtime/ws-auth.guard';
import { DrillsService } from '../src/modules/drills/drills.service';
import { SafetyService } from '../src/modules/safety/safety.service';
import { ATHLETE_ID, createSecurityFixture } from './helpers/security-gti.fixture';

describe('Phase 2 Task 3: Event Deduplication & Outbox Optimization', () => {
  const db = new PGlite({ extensions: { postgis } });
  const athleteId = randomUUID();

  before(async () => {
    const root = resolve(__dirname, '../prisma/migrations');
    for (const dir of readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await db.exec(readFileSync(resolve(root, dir.name, 'migration.sql'), 'utf8'));
    }
    await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [athleteId]);
    await db.query(
      "INSERT INTO athlete_profiles(id, user_id, district, state, primary_sport, updated_at) VALUES($1, $2, 'Pune', 'Maharashtra', 'CRICKET', now())",
      [randomUUID(), athleteId],
    );
  });

  after(async () => {
    await db.close();
  });

  it('skips duplicate imperative dispatches when transactional outbox triggers are active', async () => {
    const f = await createSecurityFixture();
    // Simulate a real PrismaClient delegate containing outboxEvent
    const prismaWithOutbox = Object.assign(Object.create(null), f.prisma, {
      outboxEvent: { updateMany: async () => ({ count: 0 }) },
    }) as PrismaService;
    const drillsWithOutbox = new DrillsService(prismaWithOutbox, f.queue);
    await drillsWithOutbox.submitDrill(
      ATHLETE_ID,
      {
        sport: SportType.CRICKET,
        drill_type: 'CRICKET_BOWLING',
        form_score: 88,
        frames_analyzed: 120,
        flaw_flags: [],
        joint_angles_summary: {},
        timestamp: Date.now(),
      },
      'a'.repeat(64),
    );
    assert.equal(f.state.jobs.length, 0, 'Trigger-backed DB relies solely on OutboxDispatcher');
  });

  it('coalesces high-frequency same-day telemetry pings so GTI is only queued when consistency score or alert state changes', async () => {
    const f = await createSecurityFixture();
    const baseTimestamp = Date.now();
    for (let i = 0; i < 10; i++) {
      await f.services.safety.processTelemetry({
        athlete_id: ATHLETE_ID,
        heart_rate: 125 + i,
        spo2: 98,
        skin_temperature: 36.8,
        timestamp: baseTimestamp + i * 1000,
      });
    }
    assert.equal(f.state.tables.wearableSession.size, 1);
    assert.equal(f.profile().trainingConsistencyScore, 5);
    assert.equal(f.state.jobs.length, 1, '10 same-day packets must emit only 1 WEARABLE_SYNC job');
  });

  it('narrows profile_delivery triggers so height/weight updates create zero outbox events while GTI/district edits notify once and handle DELETE cleanly', async () => {
    await db.exec('DELETE FROM outbox_events');
    const notified: string[] = [];
    const unsub = await db.listen('kheleo_outbox_wakeup', (payload) => {
      notified.push(payload);
    });
    try {
      await db.query('UPDATE athlete_profiles SET height_cm = 178, weight_kg = 70 WHERE user_id = $1', [
        athleteId,
      ]);
      assert.equal(
        (await db.query('SELECT id FROM outbox_events')).rows.length,
        0,
        'Non-ranking profile updates must not emit LEADERBOARD outbox events',
      );

      await db.query('UPDATE athlete_profiles SET gti = 86, current_gti = 86 WHERE user_id = $1', [
        athleteId,
      ]);
      const kinds = (
        await db.query<{ kind: string }>('SELECT kind FROM outbox_events ORDER BY kind')
      ).rows.map((r) => r.kind);
      assert.deepEqual(kinds, ['GTI_UPDATED', 'LEADERBOARD']);
      assert.ok(notified.includes('athlete_profiles'));

      // Verify DELETE trigger branch executes cleanly without record "new" errors
      const ephemeralUser = randomUUID();
      await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [ephemeralUser]);
      await db.query(
        "INSERT INTO athlete_profiles(id, user_id, district, state, updated_at) VALUES($1, $2, 'Pune', 'Maharashtra', now())",
        [randomUUID(), ephemeralUser],
      );
      await db.query('DELETE FROM athlete_profiles WHERE user_id = $1', [ephemeralUser]);
    } finally {
      await unsub();
    }
  });

  it('backs off idle polling exponentially, wakes immediately on wakeup signal, and prunes stale delivered rows via partial index', async () => {
    await db.exec('DELETE FROM outbox_events');
    const adapter = {
      $queryRaw: async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows,
      outboxEvent: {
        updateMany: async (args: Prisma.OutboxEventUpdateManyArgs) => {
          const data = args.data;
          const where = args.where!;
          const res = await db.query(
            data.deliveredAt
              ? 'UPDATE outbox_events SET delivered_at=now(),locked_by=NULL,locked_until=NULL,last_error=NULL,attempts=attempts+1 WHERE id=$1 AND locked_by=$2'
              : 'UPDATE outbox_events SET locked_by=NULL,locked_until=NULL WHERE id=$1 AND locked_by=$2',
            [where.id, where.lockedBy],
          );
          return { count: res.affectedRows ?? 0 };
        },
      },
    } as unknown as PrismaService;

    const dispatcher = new OutboxDispatcher(
      adapter,
      { enqueueGtiRecalculation: async () => 'job-1' } as unknown as QueueProducerService,
      {} as WsEventGateway,
      {} as MatchmakingGateway,
      {} as LeaderboardsService,
      {} as WsAuthGuard,
    );

    dispatcher.onApplicationBootstrap();
    try {
      // Wait briefly for initial empty poll cycle and exponential step
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(dispatcher.getPollState().currentIdlePollMs >= 2000);

      dispatcher.wakeUp();
      assert.equal(dispatcher.getPollState().currentIdlePollMs, 1000);
    } finally {
      await dispatcher.beforeApplicationShutdown();
    }

    // Seed old and fresh delivered rows and verify retention cleanup
    await db.query(
      `INSERT INTO outbox_events(id, kind, payload, delivered_at)
       VALUES ($1, 'GTI', '{}'::jsonb, now() - interval '10 days'),
              ($2, 'GTI', '{}'::jsonb, now() - interval '1 day')`,
      [randomUUID(), randomUUID()],
    );
    const pruned = await dispatcher.pruneDeliveredEvents(7, 100);
    assert.equal(pruned, 1);
    assert.equal((await db.query('SELECT id FROM outbox_events WHERE delivered_at IS NOT NULL')).rows.length, 1);

    // Verify partial index exists for pending outbox poll query
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename='outbox_events' AND indexname='outbox_events_pending_dispatch_idx'",
    );
    assert.equal(idx.rows.length, 1);
  });
});
