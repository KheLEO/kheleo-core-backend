import 'reflect-metadata';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { Prisma, SportType, VerificationStatus } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { createWave1SqlFixture } from './helpers/wave1-sql.fixture';
import { createAuthFixture } from './helpers/auth-passport.fixture';
import { runSerializableTransaction } from '../src/common/database/serializable-transaction';
import { clientIp } from '../src/common/auth/client-ip';
import { RateLimitGuard, RateLimit } from '../src/common/guards/rate-limit.guard';
import { CACHE_KEYS } from '../src/infrastructure/cache/cache-helper';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import {
  deliverDirectOutbox,
  outboxWakeupBus,
  registerOutboxWakeupPublisher,
} from '../src/infrastructure/outbox/outbox-authority';
import {
  GtiRecalculationPayload,
  QueueProducerService,
  deterministicJobId,
} from '../src/infrastructure/queues/queue-producer.service';
import { RedisWsBridge } from '../src/infrastructure/realtime/redis-ws-bridge.service';
import { AuthenticatedSocket, WsAuthGuard } from '../src/infrastructure/realtime/ws-auth.guard';
import { WsEventGateway } from '../src/infrastructure/realtime/ws-event.gateway';
import { MatchmakingGateway } from '../src/modules/matchmaking/matchmaking.gateway';
import { LeaderboardsService } from '../src/modules/leaderboards/leaderboards.service';
import { DrillsService } from '../src/modules/drills/drills.service';
import { GtiService } from '../src/modules/gti/gti.service';
import { GtiCalculationProcessor } from '../src/modules/gti/processors/gti-calculation.processor';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';

function memoryRedis() {
  const store = new Map<string, string>();
  return {
    isCacheEnabled: true,
    store,
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    del: async (key: string) => {
      store.delete(key);
    },
  };
}

describe('Wave 2: real SQL intents coordinate direct delivery, polling and worker retries', () => {
  let f: Awaited<ReturnType<typeof createWave1SqlFixture>>;
  const jobs = new Map<string, { data: GtiRecalculationPayload; id: string }>();
  const fakeQueue = {
    add: async (_name: string, data: GtiRecalculationPayload, options: { jobId: string }) => {
      if (!jobs.has(options.jobId)) jobs.set(options.jobId, { data, id: options.jobId });
      return jobs.get(options.jobId)!;
    },
  } as unknown as Queue;
  const queue = new QueueProducerService(fakeQueue, fakeQueue, fakeQueue);
  const emissions: unknown[] = [];
  let failRelay = false;
  const ws = {
    broadcastGtiUpdated: async (payload: unknown) => {
      if (failRelay) throw new Error('relay unavailable');
      emissions.push(payload);
      return true;
    },
  } as unknown as WsEventGateway;
  const boards = { syncAthlete: async () => {} } as unknown as LeaderboardsService;
  const dispatcher = () =>
    new OutboxDispatcher(f.prisma, queue, ws, {} as MatchmakingGateway, boards, {} as WsAuthGuard);
  const insertIntent = async (kind: string, payload: Prisma.JsonObject) =>
    runSerializableTransaction(f.prisma, async (tx) => {
      const id = randomUUID();
      await tx.$queryRaw(
        Prisma.sql`INSERT INTO outbox_events(id,kind,payload) VALUES(${id}::uuid,${kind},${JSON.stringify(payload)}::jsonb)`,
      );
      return { id };
    });
  const event = async (id: string) =>
    (
      await f.db.query<{ delivered_at: Date | null; last_error: string | null; attempts: number }>(
        'SELECT delivered_at,last_error,attempts FROM outbox_events WHERE id=$1',
        [id],
      )
    ).rows[0]!;

  before(async () => {
    f = await createWave1SqlFixture(true);
  });
  beforeEach(async () => {
    await f.db.exec('DELETE FROM outbox_events');
    jobs.clear();
    emissions.length = 0;
    failRelay = false;
  });
  after(async () => {
    await f.db.close();
  });

  it('a real drill queues once; polling and repeated worker delivery write only one GTI history and broadcast', async () => {
    const { userId, profileId } = await f.seedAthlete();
    await f.db.exec('DELETE FROM outbox_events');
    await new DrillsService(f.prisma, queue).submitDrill(
      userId.toUpperCase(),
      {
        sport: SportType.CRICKET,
        drill_type: 'CRICKET_BOWLING',
        form_score: 80,
        frames_analyzed: 120,
        flaw_flags: [],
        joint_angles_summary: {},
        timestamp: Date.now(),
      },
      'a'.repeat(64),
    );
    const intent = (
      await f.db.query<{ id: string; payload: { deliveryId: string }; delivered_at: Date }>(
        "SELECT * FROM outbox_events WHERE kind='GTI'",
      )
    ).rows[0]!;
    assert.ok(intent.delivered_at);
    assert.equal(jobs.size, 1);
    assert.ok(jobs.has(deterministicJobId('gti', intent.payload.deliveryId)));
    await dispatcher().dispatchOnce();
    assert.equal(jobs.size, 1);
    const processor = new GtiCalculationProcessor(new GtiService(f.prisma, boards, queue, ws));
    const job = [...jobs.values()][0]! as Job<GtiRecalculationPayload>;
    await processor.process(job);
    await processor.process(job);
    await dispatcher().dispatchOnce();
    assert.equal(
      (await f.db.query('SELECT id FROM gti_histories WHERE athlete_id=$1', [profileId])).rows
        .length,
      1,
    );
    assert.equal(emissions.length, 1);
    assert.equal(
      (await f.db.query('SELECT id FROM outbox_events WHERE delivered_at IS NULL')).rows.length,
      0,
    );
  });

  it('a direct delivery holding its SQL lease excludes a concurrent dispatcher', async () => {
    const result = await insertIntent('GTI', {
      athleteId: randomUUID(),
      trigger: 'MANUAL',
      deliveryId: 'lease-race',
    });
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deliveries = 0;
    const direct = deliverDirectOutbox(
      f.prisma,
      result,
      'GTI',
      () => true,
      async () => {
        deliveries++;
        started();
        await waiting;
      },
    );
    await entered;
    await dispatcher().dispatchOnce();
    assert.equal(jobs.size, 0);
    release();
    await direct;
    await dispatcher().dispatchOnce();
    assert.equal(deliveries, 1);
    assert.ok((await event(result.id)).delivered_at);
  });

  it('a dispatcher that wins first suppresses the direct duplicate', async () => {
    const result = await insertIntent('GTI', {
      athleteId: randomUUID(),
      trigger: 'MANUAL',
      deliveryId: 'dispatcher-first',
    });
    await dispatcher().dispatchOnce();
    let directCalls = 0;
    await deliverDirectOutbox(
      f.prisma,
      result,
      'GTI',
      () => true,
      () => {
        directCalls++;
      },
    );
    assert.equal(directCalls, 0);
    assert.equal(jobs.size, 1);
  });

  it('failed direct delivery leaves a durable retry, which polling successfully delivers', async () => {
    const result = await insertIntent('GTI', {
      athleteId: randomUUID(),
      trigger: 'MANUAL',
      deliveryId: 'retry',
    });
    await assert.rejects(
      deliverDirectOutbox(
        f.prisma,
        result,
        'GTI',
        () => true,
        async () => {
          throw new Error('queue down');
        },
      ),
      /queue down/,
    );
    assert.equal((await event(result.id)).delivered_at, null);
    await dispatcher().dispatchOnce();
    assert.ok((await event(result.id)).delivered_at);
    assert.equal((await event(result.id)).attempts, 2);
  });

  it('post-commit relay failure and BullMQ retry preserve one history while the outbox retries the relay', async () => {
    const { userId, profileId } = await f.seedAthlete();
    await f.db.exec('DELETE FROM outbox_events');
    failRelay = true;
    const service = new GtiService(f.prisma, boards, queue, ws);
    await assert.rejects(
      service.recalculateAthleteGti(userId, 'MANUAL', 'persisted-job'),
      /relay unavailable/,
    );
    await service.recalculateAthleteGti(userId, 'MANUAL', 'persisted-job');
    assert.equal(
      (await f.db.query('SELECT id FROM gti_histories WHERE athlete_id=$1', [profileId])).rows
        .length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM outbox_events WHERE kind='GTI_UPDATED' AND delivered_at IS NULL",
        )
      ).rows.length,
      1,
    );
    failRelay = false;
    await dispatcher().dispatchOnce();
    assert.equal(emissions.length, 1);
  });

  it('all direct broadcast/cache kinds acknowledge their exact trigger row so polling cannot redeliver', async () => {
    for (const kind of [
      'SCOUT',
      'MATCHMAKING',
      'ROSTER',
      'PAUSE',
      'GTI_UPDATED',
      'LEADERBOARD',
      'REVOKE_SOCKETS',
    ]) {
      const result = await insertIntent(kind, { marker: kind });
      let calls = 0;
      await deliverDirectOutbox(
        f.prisma,
        result,
        kind,
        (payload) => payload.marker === kind,
        async (row) => {
          assert.equal(row?.id, result.id);
          calls++;
          return true;
        },
      );
      await dispatcher().dispatchOnce();
      assert.equal(calls, 1);
      assert.ok((await event(result.id)).delivered_at);
      assert.equal((await event(result.id)).last_error, null);
    }
  });

  it('uses deterministic BullMQ identities for GTI, matchmaking and scout alerts even after direct/outbox retries', async () => {
    await queue.enqueueGtiRecalculation(
      { athleteId: randomUUID(), trigger: 'MANUAL' },
      'same-source',
    );
    await queue.enqueueGtiRecalculation(
      { athleteId: randomUUID(), trigger: 'MANUAL' },
      'same-source',
    );
    await queue.enqueueBracketMatchmaking({ tournamentId: randomUUID() }, 'same-source');
    await queue.enqueueBracketMatchmaking({ tournamentId: randomUUID() }, 'same-source');
    const scout = {
      alertId: 'same-source',
      athleteId: randomUUID(),
      newGti: 90,
      sport: 'CRICKET',
      state: '',
      district: '',
      tierClassification: 'RURAL',
    };
    await queue.enqueueScoutAlert(scout);
    await queue.enqueueScoutAlert(scout);
    assert.equal(jobs.size, 3);
    assert.ok([...jobs.keys()].every((id) => !id.includes(':')));
  });

  it('wakes dispatchers only after commit, never after rollback, with a safe Redis wakeup fallback', async () => {
    let wakes = 0;
    let pendingAtWake = 0;
    const listener = () => {
      wakes++;
    };
    outboxWakeupBus.on('wakeup', listener);
    registerOutboxWakeupPublisher(() => {
      throw new Error('wake publisher down');
    });
    try {
      await runSerializableTransaction(f.prisma, async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`INSERT INTO outbox_events(id,kind,payload) VALUES(${randomUUID()}::uuid,'GTI','{}')`,
        );
        pendingAtWake = wakes;
        return {};
      });
      assert.equal(pendingAtWake, 0);
      assert.equal(wakes, 1);
      await assert.rejects(
        runSerializableTransaction(f.prisma, async () => {
          throw new Error('rollback');
        }),
      );
      assert.equal(wakes, 1);
    } finally {
      outboxWakeupBus.off('wakeup', listener);
      registerOutboxWakeupPublisher(async () => {});
    }
  });

  it('failed standalone Redis publication never acknowledges REVOKE_SOCKETS or GTI relay rows; recovery does', async () => {
    let failed = true;
    const bridge = new RedisWsBridge({
      client: {
        publish: async () => {
          if (failed) throw new Error('Redis offline');
          return 1;
        },
      },
    } as unknown as RedisService);
    const guard = new WsAuthGuard({} as JwtStrategy, bridge);
    const gateway = new WsEventGateway(guard, {} as never, bridge);
    const worker = new OutboxDispatcher(
      f.prisma,
      queue,
      gateway,
      {} as MatchmakingGateway,
      boards,
      guard,
    );
    const revoke = await insertIntent('REVOKE_SOCKETS', { athleteId: randomUUID() });
    const gti = await insertIntent('GTI_UPDATED', {
      athleteId: randomUUID(),
      previousGti: 30,
      newGti: 80,
    });
    await worker.dispatchOnce();
    for (const id of [revoke.id, gti.id]) {
      assert.equal((await event(id)).delivered_at, null);
      assert.match((await event(id)).last_error!, /Redis offline/);
    }
    failed = false;
    await f.db.exec('UPDATE outbox_events SET available_at=now()');
    await worker.dispatchOnce();
    for (const id of [revoke.id, gti.id]) assert.ok((await event(id)).delivered_at);
    await assert.rejects(new RedisWsBridge().publishDisconnect('user'), /unavailable/);
    const noSubscribers = new RedisWsBridge({
      client: { publish: async () => 0 },
    } as unknown as RedisService);
    await assert.rejects(
      noSubscribers.publishEmit('/ws/events', [], 'GTI_UPDATED', {}),
      /no subscribed/,
    );
  });
});

describe('Wave 2: auth and device identity survive proxy sharing and missed pubsub', () => {
  it('HTTP and existing sockets reject inactive and banned users despite stale auth cache entries', async () => {
    for (const banned of [false, true]) {
      const auth = createAuthFixture();
      const redis = memoryRedis();
      const strategy = new JwtStrategy(
        auth.config,
        auth.database,
        redis as unknown as RedisService,
      );
      const token = {
        sub: auth.state.user.id,
        role: 'ATHLETE',
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const active = await strategy.validate(token);
      const stale = redis.store.get(CACHE_KEYS.authUser(token.sub))!;
      assert.ok(stale);
      redis.store.set(CACHE_KEYS.passport(token.sub), '{}');
      if (banned) auth.state.user.identityRecord = { status: VerificationStatus.REVOKED } as never;
      else auth.state.user.isActive = false;
      await assert.rejects(strategy.validate(token));
      assert.equal(redis.store.has(CACHE_KEYS.authUser(token.sub)), false);
      assert.equal(redis.store.has(CACHE_KEYS.passport(token.sub)), false);
      redis.store.set(CACHE_KEYS.authUser(token.sub), stale);
      let disconnected = false;
      const socket = {
        data: { user: active },
        disconnect: () => {
          disconnected = true;
        },
      } as unknown as AuthenticatedSocket;
      const guard = new WsAuthGuard(strategy);
      await assert.rejects(
        guard.canActivate({ switchToWs: () => ({ getClient: () => socket }) } as ExecutionContext),
      );
      assert.equal(disconnected, true);
    }
  });

  it('isolates users, signed telemetry athletes, and normalized auth targets behind one NAT using Redis counters', async () => {
    const keys: string[] = [];
    const counts = new Map<string, number>();
    const redis = Object.assign(memoryRedis(), {
      client: {
        eval: async (_script: string, _n: number, key: string) => {
          keys.push(key);
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return [count, 60];
        },
      },
    });
    const guard = new RateLimitGuard(undefined, redis as unknown as RedisService);
    const run = (keyPrefix: string, request: object) => {
      const handler = () => {};
      RateLimit({ keyPrefix, limit: 1, windowSeconds: 60, alwaysEnforce: true })({}, '', {
        value: handler,
      });
      return guard.canActivate({
        getType: () => 'http',
        getHandler: () => handler,
        getClass: () => Object,
        switchToHttp: () => ({
          getRequest: () => ({ ip: '192.0.2.1', ...request }),
          getResponse: () => ({ header: () => {} }),
        }),
      } as unknown as ExecutionContext);
    };
    await run('safety:telemetry', { body: { athlete_id: '00000000-0000-4000-8000-000000000001' } });
    await run('safety:telemetry', { body: { athlete_id: '00000000-0000-4000-8000-000000000002' } });
    await assert.rejects(
      run('safety:telemetry', { body: { athlete_id: '00000000-0000-4000-8000-000000000001' } }),
    );
    await run('safety:telemetry', { body: { athlete_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    await assert.rejects(
      run('safety:telemetry', { body: { athlete_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } }),
    );
    await run('auth:login', { body: { email: ' Athlete@Example.Test ' } });
    await run('auth:login', { body: { email: 'different@example.test' } });
    await assert.rejects(run('auth:login', { body: { email: 'athlete@example.test' } }));
    await run('auth:register', { body: { phone: '+91 98765-43210' } });
    await assert.rejects(run('auth:register', { body: { phone: '+919876543210' } }));
    await run('drills:submit', { user: { sub: 'athlete-one' }, body: { athlete_id: 'forged' } });
    await run('drills:submit', { user: { sub: 'athlete-two' } });
    assert.ok(keys.at(-2)!.endsWith('user:athlete-one'));
    assert.ok(keys.at(-1)!.endsWith('user:athlete-two'));
    assert.ok(!keys.join().includes('example.test'));
    assert.ok(!keys.join().includes('98765'));
  });

  it('ignores forged forwarding headers and accepts only current, signed BFF client IP assertions', () => {
    const previous = process.env.BFF_PROXY_SECRET;
    process.env.BFF_PROXY_SECRET = 'local-test-proxy-secret';
    try {
      const now = Date.now();
      const ip = '203.0.113.42';
      const timestamp = String(now);
      const key = createHmac('sha256', process.env.BFF_PROXY_SECRET)
        .update('kheleo/bff-client-ip/v1')
        .digest();
      const signature = createHmac('sha256', key).update(`${timestamp}\n${ip}`).digest('hex');
      const request = {
        ip: '192.0.2.1',
        headers: {
          'x-forwarded-for': 'fake,203.0.113.1',
          'x-kheleo-client-ip': ip,
          'x-kheleo-client-timestamp': timestamp,
          'x-kheleo-client-signature': signature,
        },
      };
      assert.equal(clientIp(request, now), ip);
      assert.equal(clientIp(request, now + 120_001), request.ip);
      assert.equal(
        clientIp(
          { ...request, headers: { ...request.headers, 'x-kheleo-client-ip': '203.0.113.99' } },
          now,
        ),
        request.ip,
      );
      assert.equal(clientIp({ ...request, headers: { 'x-forwarded-for': ip } }), request.ip);
    } finally {
      if (previous === undefined) delete process.env.BFF_PROXY_SECRET;
      else process.env.BFF_PROXY_SECRET = previous;
    }
  });
});
