import 'reflect-metadata';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ExecutionContext, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { RATE_LIMIT_KEY, RateLimitGuard, RateLimitRule } from '../src/common/guards/rate-limit.guard';
import { RedisWsBridge, WS_RELAY_CHANNEL } from '../src/infrastructure/realtime/redis-ws-bridge.service';
import { WsEventGateway } from '../src/infrastructure/realtime/ws-event.gateway';
import { WsAuthGuard } from '../src/infrastructure/realtime/ws-auth.guard';
import { RoomAccessService } from '../src/infrastructure/realtime/room-access.service';
import { MatchmakingGateway } from '../src/modules/matchmaking/matchmaking.gateway';
import { GtiCalculationProcessor } from '../src/modules/gti/processors/gti-calculation.processor';
import { ScoutAlertsProcessor } from '../src/modules/gti/processors/scout-alerts.processor';
import { MatchmakingProcessor } from '../src/modules/matchmaking/processors/matchmaking.processor';
import { createAppModuleMetadata, resolveEmbeddedWorkersEnabled } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { GtiModule, GtiWorkersModule } from '../src/modules/gti/gti.module';
import {
  MatchmakingModule,
  MatchmakingWorkersModule,
} from '../src/modules/matchmaking/matchmaking.module';
import { createAuthFixture, createAuthPassportApp } from './helpers/auth-passport.fixture';

function createHttpContext(options: {
  rule: RateLimitRule;
  ip?: string;
  userId?: string;
  headers?: Record<string, string>;
}): { context: ExecutionContext; responseHeaders: Record<string, string | number> } {
  const responseHeaders: Record<string, string | number> = {};
  const handler = function testHandler() {};
  Reflect.defineMetadata(RATE_LIMIT_KEY, options.rule, handler);

  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({
        ip: options.ip ?? '203.0.113.10',
        headers: options.headers ?? {},
        user: options.userId ? { sub: options.userId } : undefined,
      }),
      getResponse: () => ({
        header: (name: string, value: string | number) => {
          responseHeaders[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;

  return { context, responseHeaders };
}

function createPubSubPair() {
  const bus = new EventEmitter();
  const makeRedis = (throwOnPublish = false) => {
    const client = {
      duplicate: () => {
        const sub = new EventEmitter() as EventEmitter & {
          connect: () => Promise<void>;
          subscribe: (channel: string) => Promise<number>;
          quit: () => Promise<string>;
        };
        const listener = (channel: string, raw: string) => {
          sub.emit('message', channel, raw);
        };
        sub.connect = async () => {};
        sub.subscribe = async (channel: string) => {
          bus.on(channel, listener);
          return 1;
        };
        sub.quit = async () => {
          bus.removeAllListeners();
          return 'OK';
        };
        return sub;
      },
      publish: async (channel: string, message: string) => {
        if (throwOnPublish) throw new Error('Redis publish error');
        queueMicrotask(() => bus.emit(channel, channel, message));
        return 1;
      },
    };
    return { isCacheEnabled: true, client };
  };
  return { makeRedis };
}

describe('Phase 2 Task 8: Async scrypt, Distributed Rate Limit, WS Bridge & Worker Topology', () => {
  it('hashes and verifies passwords asynchronously via scrypt without blocking concurrent timer ticks', async () => {
    const fixture = createAuthFixture();
    let timerTicks = 0;
    const interval = setInterval(() => {
      timerTicks += 1;
    }, 2);

    try {
      const reg = await fixture.auth.register({
        name: 'Async Scrypt Athlete',
        email: 'async-scrypt@example.com',
        password: 'StrongPass!0',
      });
      assert.ok(reg.accessToken.length > 20);

      const logins = await Promise.all(
        Array.from({ length: 6 }, () =>
          fixture.auth.login({
            email: 'async-scrypt@example.com',
            password: 'StrongPass!0',
          }),
        ),
      );
      assert.equal(logins.length, 6);
      for (const login of logins) {
        assert.ok(login.accessToken.length > 20);
      }

      await assert.rejects(
        () =>
          fixture.auth.login({
            email: 'async-scrypt@example.com',
            password: 'WrongPassword!999',
          }),
        /Invalid login credentials/i,
      );

      assert.ok(timerTicks >= 1, `Expected async timer ticks during scrypt work, got ${timerTicks}`);
    } finally {
      clearInterval(interval);
    }
  });

  it('enforces distributed Redis rate limits and falls back to in-memory limiter when Redis errors', async () => {
    const prevRateLimit = process.env.RATE_LIMIT_ENABLED;
    process.env.RATE_LIMIT_ENABLED = 'true';

    try {
      // Case A: Redis atomic Lua eval path
      const counters = new Map<string, number>();
      const redisService = {
        isCacheEnabled: true,
        client: {
          eval: async (_script: string, _numKeys: number, key: string) => {
            const next = (counters.get(key) ?? 0) + 1;
            counters.set(key, next);
            return [next, 60];
          },
        },
      };

      const redisGuard = new RateLimitGuard(undefined, redisService as never);
      const rule: RateLimitRule = { keyPrefix: 'test:lua', limit: 3, windowSeconds: 60 };

      for (let i = 1; i <= 3; i++) {
        const { context, responseHeaders } = createHttpContext({ rule, ip: '198.51.100.4' });
        assert.equal(await redisGuard.canActivate(context), true);
        assert.equal(responseHeaders['X-RateLimit-Limit'], 3);
        assert.equal(responseHeaders['X-RateLimit-Remaining'], 3 - i);
      }

      const exceededCtx = createHttpContext({ rule, ip: '198.51.100.4' });
      await assert.rejects(
        () => redisGuard.canActivate(exceededCtx.context),
        (err: unknown) =>
          err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
      );
      assert.equal(exceededCtx.responseHeaders['X-RateLimit-Remaining'], 0);
      assert.equal(exceededCtx.responseHeaders['Retry-After'], 60);

      // Case B: Redis failure -> in-memory fallback still enforces limit cleanly
      const brokenRedis = {
        isCacheEnabled: true,
        client: {
          eval: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
      };
      const fallbackGuard = new RateLimitGuard(undefined, brokenRedis as never);
      const fallbackRule: RateLimitRule = { keyPrefix: 'test:fallback', limit: 3, windowSeconds: 45 };

      for (let i = 0; i < 3; i++) {
        const { context } = createHttpContext({ rule: fallbackRule, userId: 'athlete-fallback' });
        assert.equal(await fallbackGuard.canActivate(context), true);
      }
      const blockedFallback = createHttpContext({ rule: fallbackRule, userId: 'athlete-fallback' });
      await assert.rejects(
        () => fallbackGuard.canActivate(blockedFallback.context),
        (err: unknown) =>
          err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
      );
      assert.ok(Number(blockedFallback.responseHeaders['Retry-After']) >= 1);
    } finally {
      if (prevRateLimit === undefined) delete process.env.RATE_LIMIT_ENABLED;
      else process.env.RATE_LIMIT_ENABLED = prevRateLimit;
    }
  });

  it('enforces @RateLimit on AuthController POST /api/v1/auth/login over HTTP', async () => {
    const prevRateLimit = process.env.RATE_LIMIT_ENABLED;
    process.env.RATE_LIMIT_ENABLED = 'true';
    const fixture = createAuthFixture();
    const app = await createAuthPassportApp(fixture);

    try {
      for (let attempt = 1; attempt <= 30; attempt++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            'idempotency-key': `login-burst-key-${String(attempt).padStart(4, '0')}`,
          },
          payload: {
            email: 'missing-athlete@example.com',
            password: 'WrongPassword123',
          },
        });
        assert.equal(res.statusCode, 401);
      }

      const throttled = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          'idempotency-key': 'login-burst-key-0031',
        },
        payload: {
          email: 'missing-athlete@example.com',
          password: 'WrongPassword123',
        },
      });
      assert.equal(throttled.statusCode, 429);
      assert.equal(throttled.headers['x-ratelimit-limit'], '30');
      assert.equal(throttled.headers['x-ratelimit-remaining'], '0');
      assert.ok(Number(throttled.headers['retry-after']) >= 1);
    } finally {
      if (prevRateLimit === undefined) delete process.env.RATE_LIMIT_ENABLED;
      else process.env.RATE_LIMIT_ENABLED = prevRateLimit;
      await app.close();
    }
  });

  it('relays worker WebSocket events and forced disconnects across RedisWsBridge when gateway server is absent', async () => {
    const { makeRedis } = createPubSubPair();
    const apiRedis = makeRedis();
    const workerRedis = makeRedis();

    const apiBridge = new RedisWsBridge(apiRedis as never);
    const workerBridge = new RedisWsBridge(workerRedis as never);

    const emitted: Array<{ ns: string; rooms: string[]; event: string; payload: unknown }> = [];
    const disconnected: string[] = [];

    const createNamespaceMock = (nsName: string) => ({
      use: () => {},
      in: (room: string) => ({
        disconnectSockets: () => {
          disconnected.push(`${nsName}:${room}`);
        },
      }),
      local: {
        to: (rooms: string[]) => ({
          emit: (event: string, payload: unknown) => {
            emitted.push({ ns: nsName, rooms, event, payload });
          },
        }),
        emit: (event: string, payload: unknown) => {
          emitted.push({ ns: nsName, rooms: [], event, payload });
        },
      },
    });

    const dummyJwtStrategy = { authenticateToken: async () => ({}) } as never;
    const dummyAccess = { canJoin: async () => true } as unknown as RoomAccessService;

    const apiGuard = new WsAuthGuard(dummyJwtStrategy, apiBridge);
    const apiEventsGateway = new WsEventGateway(apiGuard, dummyAccess, apiBridge);
    const apiMatchmakingGateway = new MatchmakingGateway(apiGuard, dummyAccess, apiBridge);

    apiEventsGateway.afterInit(createNamespaceMock('/ws/events') as never);
    apiMatchmakingGateway.afterInit(createNamespaceMock('/ws/matchmaking') as never);

    // Wait a tick for async subscribe(WS_RELAY_CHANNEL) to attach
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Worker instances intentionally have server === undefined (headless worker.ts context)
    const workerGuard = new WsAuthGuard(dummyJwtStrategy, workerBridge);
    const workerEventsGateway = new WsEventGateway(workerGuard, dummyAccess, workerBridge);
    const workerMatchmakingGateway = new MatchmakingGateway(workerGuard, dummyAccess, workerBridge);

    workerEventsGateway.broadcastGtiUpdated({
      eventId: 'evt-gti-1',
      athleteId: 'ath-1',
      previousGti: 65,
      newGti: 88,
      eliteBreached: true,
    });
    workerEventsGateway.broadcastAutonomousMatchPause({
      event_id: 'evt-pause-1',
      alert_id: 'alert-1',
      event: 'MATCH_PAUSE_ALERT',
      severity: 'CRITICAL',
      athlete_id: 'ath-1',
      athlete_name: 'Riya Sharma',
      vitals: { heart_rate: 205, spo2: 88, skin_temperature: 40.1 },
      directive: 'Pause match immediately',
      tournament_id: 'tour-1',
    });
    workerEventsGateway.broadcastScoutTalent({
      alertId: 'scout-1',
      athleteId: 'ath-1',
      newGti: 88,
      sport: 'ATHLETICS',
      district: 'Pune',
      state: 'Maharashtra',
      tierClassification: 'TIER_1',
    });
    workerMatchmakingGateway.emitRosterFormed(
      {
        team_id: 'team-1',
        team_name: 'Pune Panthers',
        bracket_id: 'br-1',
        roster: [{ user_id: 'ath-1', name: 'Riya Sharma', assigned_role: 'ANCHOR', gti: 88 }],
      },
      'evt-roster-1',
    );
    workerGuard.disconnectUser('ath-1');

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(
      WS_RELAY_CHANNEL,
      'kheleo:ws:relay',
    );
    assert.ok(
      emitted.some(
        (m) => m.ns === '/ws/events' && m.event === 'GTI_UPDATED' && m.rooms.includes('athlete:ath-1'),
      ),
    );
    assert.ok(
      emitted.some(
        (m) =>
          m.ns === '/ws/events' &&
          m.event === 'MATCH_PAUSE_ALERT' &&
          m.rooms.includes('safety:tournament:tour-1'),
      ),
    );
    assert.ok(
      emitted.some(
        (m) =>
          m.ns === '/ws/events' && m.event === 'SCOUT_TALENT_ALERT' && m.rooms.includes('scouts'),
      ),
    );
    assert.ok(
      emitted.some(
        (m) =>
          m.ns === '/ws/matchmaking' &&
          m.event === 'ROSTER_FORMED' &&
          m.rooms.includes('bracket:br-1') &&
          m.rooms.includes('user:ath-1'),
      ),
    );
    assert.ok(disconnected.includes('/ws/events:user:ath-1'));
    assert.ok(disconnected.includes('/ws/matchmaking:user:ath-1'));

    await apiBridge.onModuleDestroy();
    await workerBridge.onModuleDestroy();
  });

  it('logs DLQ_ALERT on final failed job attempt in all BullMQ processors and splits API/Worker topology cleanly', () => {
    const errors: string[] = [];
    const origLoggerError = Logger.prototype.error;
    Logger.prototype.error = function patchedError(message: unknown, ...rest: unknown[]) {
      errors.push(String(message));
      return origLoggerError.call(this, message, ...rest);
    };

    try {
      const gtiProc = new GtiCalculationProcessor({} as never);
      const scoutProc = new ScoutAlertsProcessor({} as never, {} as never);
      const mmProc = new MatchmakingProcessor({} as never);

      // Non-final retry must NOT emit DLQ_ALERT
      gtiProc.onFailed(
        { id: 'j1', data: { athleteId: 'ath-retry' }, opts: { attempts: 3 }, attemptsMade: 1 } as never,
        new Error('Transient error'),
      );
      assert.equal(errors.filter((e) => e.includes('DLQ_ALERT')).length, 0);

      // Final attempts must emit DLQ_ALERT with queue & job metadata
      gtiProc.onFailed(
        { id: 'j2', data: { athleteId: 'ath-dead' }, opts: { attempts: 3 }, attemptsMade: 3 } as never,
        new Error('DB dead'),
      );
      scoutProc.onFailed(
        { id: 'j3', data: { alertId: 'alert-dead' }, opts: { attempts: 3 }, attemptsMade: 3 } as never,
        new Error('Scout WS error'),
      );
      mmProc.onFailed(
        { id: 'j4', data: { bracketId: 'br-dead' }, opts: { attempts: 3 }, attemptsMade: 3 } as never,
        new Error('Pool lock error'),
      );

      assert.ok(errors.some((e) => e.includes('DLQ_ALERT queue=gti-calculation') && e.includes('ath-dead')));
      assert.ok(errors.some((e) => e.includes('DLQ_ALERT queue=scout-alerts') && e.includes('alert-dead')));
      assert.ok(errors.some((e) => e.includes('DLQ_ALERT queue=matchmaking') && e.includes('br-dead')));
    } finally {
      Logger.prototype.error = origLoggerError;
    }

    assert.equal(resolveEmbeddedWorkersEnabled({ ENABLE_EMBEDDED_WORKERS: 'false' }), false);
    assert.equal(resolveEmbeddedWorkersEnabled({ ENABLE_EMBEDDED_WORKERS: 'true' }), true);
    assert.equal(resolveEmbeddedWorkersEnabled({}), true);

    const apiOnlyMeta = createAppModuleMetadata(false);
    assert.equal(apiOnlyMeta.providers?.includes(OutboxDispatcher), false);
    assert.equal(apiOnlyMeta.imports?.includes(GtiModule), true);
    assert.equal(apiOnlyMeta.imports?.includes(MatchmakingModule), true);
    assert.equal(apiOnlyMeta.imports?.includes(GtiWorkersModule), false);
    assert.equal(apiOnlyMeta.imports?.includes(MatchmakingWorkersModule), false);

    const monolithicMeta = createAppModuleMetadata(true);
    assert.equal(monolithicMeta.providers?.includes(OutboxDispatcher), true);
    assert.equal(monolithicMeta.imports?.includes(GtiWorkersModule), true);
    assert.equal(monolithicMeta.imports?.includes(MatchmakingWorkersModule), true);

    const workerProviders = Reflect.getMetadata('providers', WorkerModule) as unknown[];
    const workerImports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    assert.equal(workerProviders.includes(OutboxDispatcher), true);
    assert.equal(workerImports.includes(GtiWorkersModule), true);
    assert.equal(workerImports.includes(MatchmakingWorkersModule), true);
  });
});
