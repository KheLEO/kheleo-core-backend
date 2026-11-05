import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ForbiddenException,
  ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from '../src/common/interceptors/idempotency.interceptor';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AlertSeverity,
  GovIdType,
  Prisma,
  SportType,
  UserRole,
  VerificationStatus,
} from '@prisma/client';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from 'jsonwebtoken';
import {
  createAuthFixture,
  createAuthPassportApp,
  fixtureToken,
  SUPABASE_TEST_SECRET,
  TEST_DOCUMENT,
  TEST_OTHER_ID,
  TEST_SECRET,
  TEST_USER_ID,
} from './helpers/auth-passport.fixture';
import { StandardApiResponse } from '../src/common/interceptors/response-transform.interceptor';
import { AthletePassportDto } from '../src/modules/passport/dto/passport-response.dto';
import { AthleteDossierResponse } from '../src/modules/scouts/dossiers.service';
import { AuthResponseDto } from '../src/modules/auth/dto/auth-response.dto';
import { BracketsService } from '../src/modules/brackets/brackets.service';
import { MatchmakingService } from '../src/modules/matchmaking/matchmaking.service';
import { QueueProducerService } from '../src/infrastructure/queues/queue-producer.service';
import { MatchmakingGateway } from '../src/modules/matchmaking/matchmaking.gateway';
import { WsEventGateway } from '../src/infrastructure/realtime/ws-event.gateway';
import {
  createCompetitionApp,
  createCompetitionFixture,
  makeTournament,
  TOURNAMENT_ID,
  BRACKET_ID,
  OTHER_OWNER_ID,
} from './helpers/competition.fixture';
import { Tournament } from '@prisma/client';
import { PaginatedResponseDto } from '../src/common/dto/paginated-response.dto';
import {
  geographicBoundingBox,
  haversineDistance,
} from '../src/infrastructure/database/geo-distance';

interface TestReply {
  statusCode: number;
  header(name: string, value: string): TestReply;
  status(code: number): TestReply;
}

class InMemoryRedis {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async setnx(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async deleteIfValueMatches(key: string, expectedValue: string): Promise<boolean> {
    if (this.values.get(key) !== expectedValue) return false;
    return this.values.delete(key);
  }
}

interface RequestOptions {
  readonly actorId?: string;
  readonly deviceSignature?: string | readonly string[];
  readonly ip?: string;
  readonly method?: string;
}

function createContext(
  key: string | undefined,
  url: string,
  body: Readonly<Record<string, unknown>>,
  options: RequestOptions = {},
): ExecutionContext {
  const request = {
    method: options.method ?? 'POST',
    url,
    body,
    ip: options.ip ?? '127.0.0.1',
    user: options.actorId ? { sub: options.actorId } : undefined,
    headers: {
      ...(key ? { 'idempotency-key': key } : {}),
      ...(options.deviceSignature ? { 'x-device-signature': options.deviceSignature } : {}),
    },
  };
  const reply: TestReply = {
    statusCode: 201,
    header: () => reply,
    status: (code: number) => {
      reply.statusCode = code;
      return reply;
    },
  };
  return {
    getHandler: () => createContext,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('Audit hardening regressions', () => {
  it('requires an idempotency key on protected mutations', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };

    await assert.rejects(
      interceptor.intercept(createContext(undefined, '/drills/submit', {}), next),
      BadRequestException,
    );
  });

  describe('Realtime authorization regressions', () => {
    it('rejects unrelated athlete subscriptions to competition rooms', async () => {
      const f = await createSecurityFixture();
      const gateway = new WsEventGateway(f.sockets, new RoomAccessService(f.prisma));
      const joins: string[] = [];
      const client = {
        data: { user: { sub: randomUUID(), role: 'ATHLETE' } },
        join: (room: string) => {
          joins.push(room);
        },
      } as unknown as AuthenticatedSocket;
      await assert.rejects(
        gateway.handleJoinTournament(client, { tournamentId: TOURNAMENT_ID }),
        ForbiddenException,
      );
      await assert.rejects(
        gateway.handleJoinMatch(client, { matchId: MATCH_ID }),
        ForbiddenException,
      );
      assert.deepStrictEqual(joins, []);
    });
    it('rejects an organizer from another organizer’s tournament room', async () => {
      const f = await createSecurityFixture();
      const gateway = new WsEventGateway(f.sockets, new RoomAccessService(f.prisma));
      const client = {
        data: { user: { sub: TEST_USER_ID, role: 'ORGANIZER' } },
        join: () => undefined,
      } as unknown as AuthenticatedSocket;
      await assert.rejects(
        gateway.handleJoinTournament(client, { tournamentId: TOURNAMENT_ID }),
        ForbiddenException,
      );
    });
    it('allows an assigned umpire to join a match room', async () => {
      const f = await createSecurityFixture();
      const gateway = new WsEventGateway(f.sockets, new RoomAccessService(f.prisma));
      const joins: string[] = [];
      const client = {
        data: { user: { sub: UMPIRE_ID, role: 'UMPIRE' } },
        join: (room: string) => {
          joins.push(room);
        },
      } as unknown as AuthenticatedSocket;
      await gateway.handleJoinMatch(client, { matchId: MATCH_ID });
      assert.deepStrictEqual(joins, [`match:${MATCH_ID}`, `safety:match:${MATCH_ID}`]);
    });
    it('does not globally broadcast sensitive match-pause events', async () => {
      const f = await createSecurityFixture();
      const gateway = new WsEventGateway(f.sockets, new RoomAccessService(f.prisma));
      const rooms: string[] = [];
      let global = 0;
      gateway.server = {
        to: (targets: string[]) => ({ emit: () => rooms.push(...targets) }),
        emit: () => global++,
      } as unknown as AuthenticatedNamespace;
      gateway.broadcastAutonomousMatchPause({
        ...medicalEvent,
        tournament_id: TOURNAMENT_ID,
        bracket_id: BRACKET_ID,
      });
      assert.strictEqual(global, 0);
      assert.deepStrictEqual(
        new Set(rooms),
        new Set([
          `safety:tournament:${TOURNAMENT_ID}`,
          `safety:bracket:${BRACKET_ID}`,
          `safety:match:${MATCH_ID}`,
        ]),
      );
    });
    it('restricts matchmaking bracket subscriptions to the tournament owner', async () => {
      const f = await createSecurityFixture();
      const gateway = new MatchmakingGateway(f.sockets, new RoomAccessService(f.prisma));
      const client = (role: string): AuthenticatedSocket =>
        ({
          data: { user: { sub: TEST_USER_ID, role } },
          join: () => undefined,
        }) as unknown as AuthenticatedSocket;
      await assert.rejects(
        gateway.handleJoinBracket(client('ATHLETE'), { bracketId: BRACKET_ID }),
        ForbiddenException,
      );
      await assert.rejects(
        gateway.handleJoinBracket(client('ORGANIZER'), { bracketId: BRACKET_ID }),
        ForbiddenException,
      );
    });
  });

  it('rejects reuse of a key with a different request payload', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };
    const key = 'stable-idempotency-key-1';

    const first = await interceptor.intercept(
      createContext(key, '/free-agents/join', { role: 'BOWLER' }),
      next,
    );
    await firstValueFrom(first);

    await assert.rejects(
      interceptor.intercept(createContext(key, '/free-agents/join', { role: 'BATSMAN' }), next),
      ConflictException,
    );
  });

  it('scopes the same key independently to each mutation route', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };
    const key = 'stable-idempotency-key-2';

    const first = await interceptor.intercept(
      createContext(key, '/auth/register', { phone: '+919000000001' }),
      next,
    );
    await firstValueFrom(first);
    const second = await interceptor.intercept(
      createContext(key, '/drills/submit', { form_score: 90 }),
      next,
    );
    await firstValueFrom(second);

    assert.strictEqual(
      [...redis.values.keys()].filter((keyName) => keyName.startsWith('idempotency:')).length,
      2,
    );
  });

  it('isolates athlete-A and athlete-B caches and active locks for identical requests', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const key = 'same-cross-user-idempotency-key';
    const url = '/api/v1/free-agents/join?bracket=one';
    const body = { role: 'BOWLER' };
    const executions: string[] = [];
    const handler = (actorId: string): CallHandler => ({
      handle: () => {
        executions.push(actorId);
        return of({ registrationId: `registration-${actorId}`, owner: actorId });
      },
    });
    const contextA = createContext(key, url, body, { actorId: 'athlete-A' });
    const contextB = createContext(key, url, body, { actorId: 'athlete-B' });

    const requestA = await interceptor.intercept(contextA, handler('athlete-A'));
    const requestB = await interceptor.intercept(contextB, handler('athlete-B'));
    assert.strictEqual(
      [...redis.values.keys()].filter((name) => name.startsWith('lock:')).length,
      2,
    );

    const [responseA, responseB] = await Promise.all([
      firstValueFrom(requestA),
      firstValueFrom(requestB),
    ]);
    assert.deepStrictEqual(responseA, {
      registrationId: 'registration-athlete-A',
      owner: 'athlete-A',
    });
    assert.deepStrictEqual(responseB, {
      registrationId: 'registration-athlete-B',
      owner: 'athlete-B',
    });

    assert.deepStrictEqual(
      await firstValueFrom(await interceptor.intercept(contextA, handler('athlete-A'))),
      responseA,
    );
    assert.deepStrictEqual(
      await firstValueFrom(await interceptor.intercept(contextB, handler('athlete-B'))),
      responseB,
    );
    assert.deepStrictEqual(executions, ['athlete-A', 'athlete-B']);
  });

  it('replays canonical JSON despite reordered nested keys and preserves array order', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const executions: string[] = [];
    const next: CallHandler = {
      handle: () => {
        executions.push('executed');
        return of({ success: true });
      },
    };
    const key = 'canonical-json-idempotency-key';
    const original = {
      role: 'BOWLER',
      profile: { age: 20, name: 'A' },
      scores: [{ a: 1, b: 2 }, 3],
    };
    const reordered = {
      scores: [{ b: 2, a: 1 }, 3],
      profile: { name: 'A', age: 20 },
      role: 'BOWLER',
    };
    await firstValueFrom(await interceptor.intercept(createContext(key, '/join', original), next));
    await firstValueFrom(await interceptor.intercept(createContext(key, '/join', reordered), next));
    assert.deepStrictEqual(executions, ['executed']);
    await assert.rejects(
      interceptor.intercept(
        createContext(key, '/join', { ...reordered, scores: [3, { a: 1, b: 2 }] }),
        next,
      ),
      ConflictException,
    );
  });

  it('includes query strings, HTTP methods, devices, and IPs in the request scope', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const executions: string[] = [];
    const next: CallHandler = {
      handle: () => {
        executions.push('executed');
        return of({ sequence: executions.length });
      },
    };
    const key = 'scope-components-idempotency-key';
    const cases: ReadonlyArray<{ readonly url: string; readonly options: RequestOptions }> = [
      { url: '/join?bracket=one', options: {} },
      { url: '/join?bracket=two', options: {} },
      { url: '/join?bracket=one', options: { method: 'PATCH' } },
      { url: '/join?bracket=one', options: { deviceSignature: ['device-A'] } },
      { url: '/join?bracket=one', options: { deviceSignature: 'device-B' } },
      { url: '/join?bracket=one', options: { ip: '127.0.0.2' } },
    ];
    for (const { url, options } of cases) {
      await firstValueFrom(await interceptor.intercept(createContext(key, url, {}, options), next));
    }
    assert.strictEqual(executions.length, cases.length);
  });

  it('uses authenticated identity ahead of an untrusted device header', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };
    const key = 'authenticated-scope-idempotency-key';
    const request = await interceptor.intercept(
      createContext(key, '/join', {}, { actorId: 'athlete-A', deviceSignature: 'device-A' }),
      next,
    );
    await firstValueFrom(request);
    const cachedOnly: CallHandler = {
      handle: () => {
        throw new Error('Handler must not execute.');
      },
    };
    await firstValueFrom(
      await interceptor.intercept(
        createContext(key, '/join', {}, { actorId: 'athlete-A', deviceSignature: 'device-B' }),
        cachedOnly,
      ),
    );
  });

  it('blocks a concurrent duplicate from the same actor', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const context = createContext(
      'concurrent-idempotency-key',
      '/join',
      {},
      { actorId: 'athlete-A' },
    );
    const next: CallHandler = { handle: () => of({ success: true }) };
    const first = await interceptor.intercept(context, next);
    await assert.rejects(interceptor.intercept(context, next), ConflictException);
    await firstValueFrom(first);
    assert.strictEqual(
      [...redis.values.keys()].some((name) => name.startsWith('lock:')),
      false,
    );
  });

  for (const fails of [false, true]) {
    it(`preserves a successor lock after lease expiry on ${fails ? 'error' : 'success'}`, async () => {
      const redis = new InMemoryRedis();
      const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
      const failure = new Error('Mutation failed.');
      const next: CallHandler = {
        handle: () => (fails ? throwError(() => failure) : of({ success: true })),
      };
      const request = await interceptor.intercept(
        createContext('lock-expiry-idempotency-key', '/join', {}),
        next,
      );
      const lockEntry = [...redis.values.entries()].find(([name]) => name.startsWith('lock:'));
      assert.ok(lockEntry);
      const [lockKey, ownerToken] = lockEntry;
      assert.match(ownerToken, /^[0-9a-f-]{36}$/);
      redis.values.set(lockKey, 'successor-owner-token');
      if (fails) {
        await assert.rejects(firstValueFrom(request), failure);
      } else {
        await firstValueFrom(request);
      }
      assert.strictEqual(redis.values.get(lockKey), 'successor-owner-token');
    });
  }

  it('releases its own lock after a synchronous handler failure', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const failure = new Error('Synchronous handler failure.');
    const next: CallHandler = {
      handle: () => {
        throw failure;
      },
    };
    const request = await interceptor.intercept(
      createContext('sync-failure-idempotency-key', '/join', {}),
      next,
    );
    await assert.rejects(firstValueFrom(request), failure);
    assert.strictEqual(redis.values.size, 0);
  });
});

const profileInput = {
  dateOfBirth: '2000-01-01',
  gender: 'FEMALE',
  primarySport: SportType.CRICKET,
  district: 'Pune',
  state: 'Maharashtra',
};

type AuthFixture = ReturnType<typeof createAuthFixture>;

async function withAuthApp(
  operation: (fixture: AuthFixture, app: NestFastifyApplication) => Promise<void>,
  fixture: AuthFixture = createAuthFixture(),
): Promise<void> {
  const app = await createAuthPassportApp(fixture);
  try {
    await operation(fixture, app);
  } finally {
    await app.close();
  }
}

function authenticatedHeaders(
  key = randomUUID(),
  token = fixtureToken(),
): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${token}`, 'idempotency-key': key };
}

describe('Phase 2 auth and frontend HTTP contracts', () => {
  it('rejects missing or malformed governmentId with HTTP 400 rather than TypeError', async () => {
    await withAuthApp(async (_fixture, app) => {
      for (const governmentId of [
        undefined,
        null,
        {},
        [],
        'invalid',
        { idType: 'AADHAAR' },
        { idNumber: TEST_DOCUMENT },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: authenticatedHeaders(),
          payload: { phone: '+919000000001', governmentId },
        });
        assert.strictEqual(response.statusCode, 400, response.body);
        assert.strictEqual(response.body.includes('TypeError'), false);
      }
    });
  });

  for (const state of [
    'deactivated',
    VerificationStatus.REVOKED,
    VerificationStatus.FLAGGED_DUPLICATE,
  ] as const) {
    it(`rejects ${state} users on login, refresh, and protected HTTP requests`, async () => {
      await withAuthApp(async (fixture, app) => {
        if (state === 'deactivated') fixture.state.user.isActive = false;
        else {
          assert.ok(fixture.state.user.identityRecord);
          fixture.state.user.identityRecord.status = state;
        }
        const login = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: authenticatedHeaders(),
          payload: {
            phone: fixture.state.user.phone,
            governmentId: { idType: GovIdType.AADHAAR, idNumber: TEST_DOCUMENT },
          },
        });
        assert.strictEqual(login.statusCode, 403, login.body);
        const refresh = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          headers: authenticatedHeaders(),
          payload: { refreshToken: 'fixture-refresh-token' },
        });
        assert.strictEqual(refresh.statusCode, 403, refresh.body);
        const profile = await app.inject({
          method: 'GET',
          url: '/api/v1/users/profile',
          headers: authenticatedHeaders(),
        });
        assert.strictEqual(profile.statusCode, 403, profile.body);
      });
    });
  }

  it('revalidates login and refresh state even when an idempotency key is reused', async () => {
    await withAuthApp(async (fixture, app) => {
      const loginPayload = {
        phone: fixture.state.user.phone,
        governmentId: { idType: GovIdType.AADHAAR, idNumber: TEST_DOCUMENT },
      };
      const loginKey = randomUUID();
      const firstLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: authenticatedHeaders(loginKey),
        payload: loginPayload,
      });
      assert.strictEqual(firstLogin.statusCode, 200, firstLogin.body);
      assert.strictEqual(
        firstLogin.json<StandardApiResponse<AuthResponseDto>>().data.tokenType,
        'Bearer',
      );
      fixture.state.user.isActive = false;
      assert.strictEqual(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            headers: authenticatedHeaders(loginKey),
            payload: loginPayload,
          })
        ).statusCode,
        403,
      );
      fixture.state.user.isActive = true;
      const refreshKey = randomUUID();
      const payload = { refreshToken: 'fixture-refresh-token' };
      assert.strictEqual(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/refresh',
            headers: authenticatedHeaders(refreshKey),
            payload,
          })
        ).statusCode,
        200,
      );
      assert.ok(fixture.state.user.identityRecord);
      fixture.state.user.identityRecord.status = VerificationStatus.REVOKED;
      assert.strictEqual(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/refresh',
            headers: authenticatedHeaders(refreshKey),
            payload,
          })
        ).statusCode,
        403,
      );
    });
  });

  it('supports both government-ID verification routes and all requested field aliases', async () => {
    await withAuthApp(async (fixture, app) => {
      await fixture.passports.upsertPassport(TEST_USER_ID, profileInput);
      assert.ok(fixture.state.profile);
      fixture.state.profile.currentGti = new Prisma.Decimal(82);
      for (const route of ['verify-government-id', 'verify-gov-id']) {
        for (const payload of [
          { idType: 'AADHAAR', idNumber: TEST_DOCUMENT },
          { id_type: 'AADHAAR', id_number: TEST_DOCUMENT },
          { gov_id: TEST_DOCUMENT },
          { idNumber: TEST_DOCUMENT },
        ]) {
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/auth/${route}`,
            headers: authenticatedHeaders(),
            payload,
          });
          assert.strictEqual(response.statusCode, 200, response.body);
          const body = response.json<
            StandardApiResponse<{
              readonly userId: string;
              readonly athleteProfileId: string;
              readonly currentGti: number;
              readonly verified: boolean;
            }>
          >().data;
          assert.strictEqual(body.userId, TEST_USER_ID);
          assert.strictEqual(body.athleteProfileId, fixture.state.profile.id);
          assert.strictEqual(body.currentGti, 82);
          assert.strictEqual(body.verified, true);
        }
      }
    });
  });

  it('routes users/profile before UUID routes and persists one default passport', async () => {
    await withAuthApp(async (_fixture, app) => {
      const first = await app.inject({
        method: 'GET',
        url: '/api/v1/users/profile',
        headers: authenticatedHeaders(),
      });
      assert.strictEqual(first.statusCode, 200, first.body);
      const body = first.json<StandardApiResponse<AthletePassportDto>>().data;
      assert.strictEqual(body.userId, TEST_USER_ID);
      assert.strictEqual(body.dateOfBirth, null);
      assert.strictEqual(body.isProfileComplete, false);
      const second = await app.inject({
        method: 'GET',
        url: '/api/v1/users/profile',
        headers: authenticatedHeaders(),
      });
      assert.strictEqual(
        second.json<StandardApiResponse<AthletePassportDto>>().data.athleteProfileId,
        body.athleteProfileId,
      );
      assert.strictEqual(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/users/${TEST_USER_ID}`,
            headers: authenticatedHeaders(),
          })
        ).statusCode,
        200,
      );
    });
  });

  it('upserts camelCase profiles and sport records, then patches snake_case fields without resetting GTI', async () => {
    await withAuthApp(async (fixture, app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/users/profile',
        headers: authenticatedHeaders(),
        payload: {
          ...profileInput,
          secondarySports: ['FOOTBALL'],
          heightCm: 170,
          weightKg: 65,
          dominantSide: 'RIGHT',
          locationLat: 19,
          locationLng: 72,
          isScoutSearchable: true,
          sportRecords: [{ sport: 'CRICKET', primaryRole: 'BOWLER' }],
        },
      });
      assert.strictEqual(created.statusCode, 201, created.body);
      assert.ok(fixture.state.profile);
      fixture.state.profile.currentGti = new Prisma.Decimal(78);
      const updated = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/profile',
        headers: authenticatedHeaders(),
        payload: {
          date_of_birth: '2001-02-03',
          primary_sport: 'BADMINTON',
          secondary_sports: ['CRICKET'],
          height_cm: 172,
          weight_kg: 66,
          dominant_side: 'LEFT',
          location_lat: -23,
          location_lng: 120,
          is_scout_searchable: false,
          sport_records: [
            { sport: 'BADMINTON', primary_role: 'SINGLES', secondary_roles: ['DOUBLES'] },
          ],
        },
      });
      assert.strictEqual(updated.statusCode, 200, updated.body);
      const body = updated.json<StandardApiResponse<AthletePassportDto>>().data;
      assert.strictEqual(body.currentGti, 78);
      assert.strictEqual(body.primarySport, 'BADMINTON');
      assert.strictEqual(body.physicalStats.heightCm, 172);
      assert.strictEqual(body.physicalStats.weightKg, 66);
      assert.strictEqual(body.physicalStats.dominantSide, 'LEFT');
      assert.strictEqual(body.locationLat, -23);
      assert.strictEqual(body.locationLng, 120);
      assert.strictEqual(body.isScoutSearchable, false);
      assert.strictEqual(body.isProfileComplete, true);
      assert.strictEqual(
        body.sportRecords.find((entry) => entry.sport === 'BADMINTON')?.primaryRole,
        'SINGLES',
      );
      assert.strictEqual(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/passport/${TEST_USER_ID}`,
            headers: authenticatedHeaders(),
          })
        ).statusCode,
        200,
      );
    });
  });

  it('rejects invalid coordinates, dates, ambiguous aliases, and self-claimed verified statistics', async () => {
    await withAuthApp(async (_fixture, app) => {
      for (const payload of [
        { location_lat: -91 },
        { locationLat: 91 },
        { location_lng: -181 },
        { locationLng: 181 },
        { date_of_birth: 'not-a-date' },
        { primary_sport: 'NOT_A_SPORT' },
        { is_scout_searchable: 'false' },
        { heightCm: 170, height_cm: 180 },
        {
          sport_records: [
            { sport: 'CRICKET', primary_role: 'BOWLER', verifiedMetrics: { wins: 100 } },
          ],
        },
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/v1/users/profile',
          headers: authenticatedHeaders(),
          payload,
        });
        assert.strictEqual(response.statusCode, 400, response.body);
      }
      const missingKey = await app.inject({
        method: 'POST',
        url: '/api/v1/users/profile',
        headers: { authorization: `Bearer ${fixtureToken()}` },
        payload: profileInput,
      });
      assert.strictEqual(missingKey.statusCode, 400);
    });
  });

  it('returns bounded dossier summaries for the athlete without exposing ID hashes or raw medical readings', async () => {
    await withAuthApp(async (fixture, app) => {
      await fixture.passports.upsertPassport(TEST_USER_ID, {
        ...profileInput,
        sportRecords: [{ sport: SportType.CRICKET, primaryRole: 'BOWLER' }],
      });
      assert.ok(fixture.state.profile);
      fixture.state.profile.currentGti = new Prisma.Decimal(81);
      fixture.state.profile.gtiHistories.push({
        id: randomUUID(),
        athleteId: fixture.state.profile.id,
        biomechanicalScore: new Prisma.Decimal(80),
        wearableScore: new Prisma.Decimal(70),
        matchScore: new Prisma.Decimal(60),
        compositeGti: new Prisma.Decimal(71),
        calculationFactors: {},
        calculatedAt: new Date(),
      });
      fixture.state.user.drillSubmissions.push({
        id: randomUUID(),
        athleteId: TEST_USER_ID,
        sport: 'CRICKET',
        drillType: 'BOWLING',
        formScore: 82,
        framesAnalyzed: 10,
        flawFlags: [],
        jointAnglesSummary: {},
        signatureHash: 'private-signature',
        signatureVersion: 'LEGACY',
        clientPoseDigest: null,
        metadataVerified: false,
        createdAt: new Date(),
      });
      fixture.state.user.healthAlerts.push({
        id: randomUUID(),
        athleteId: TEST_USER_ID,
        tournamentId: null,
        bracketId: null,
        severity: AlertSeverity.CRITICAL,
        heartRate: 200,
        spo2: 89,
        skinTemperature: 40,
        triggerReason: 'Private telemetry',
        matchPaused: true,
        matchId: null,
        acknowledgedAt: null,
        acknowledgedById: null,
        medicalCheckNote: null,
        medicalCheckDispatched: false,
        source: 'DEVICE_HMAC',
        baselineFields: [],
        createdAt: new Date(),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${TEST_USER_ID}/dossier`,
        headers: authenticatedHeaders(),
      });
      assert.strictEqual(response.statusCode, 200, response.body);
      const body = response.json<StandardApiResponse<AthleteDossierResponse>>().data;
      assert.strictEqual(body.athlete_id, TEST_USER_ID);
      assert.strictEqual(body.gti_breakdown.gti, 81);
      assert.strictEqual(body.is_verified, true);
      assert.strictEqual(body.gti_history[0]?.gti, 71);
      assert.strictEqual(body.recent_drills[0]?.drill_type, 'BOWLING');
      assert.strictEqual(body.physiological_resilience.status, 'CRITICAL');
      assert.strictEqual(body.sport_records[0]?.primary_role, 'BOWLER');
      assert.strictEqual(response.body.includes('private-signature'), false);
      assert.strictEqual(response.body.includes('heartRate'), false);
      assert.strictEqual(response.body.includes('idHash'), false);
      const select = fixture.state.profileQueries.at(-1)?.select;
      assert.ok(select && typeof select.gtiHistories === 'object' && select.gtiHistories);
      assert.strictEqual(select.gtiHistories.take, 20);
      assert.ok(
        typeof select.user === 'object' &&
          select.user &&
          typeof select.user.select?.drillSubmissions === 'object',
      );
      assert.strictEqual(select.user.select.drillSubmissions.take, 10);
    });
  });

  for (const role of [
    UserRole.SCOUT,
    UserRole.ORGANIZER,
    UserRole.FEDERATION_ADMIN,
    UserRole.SUPER_ADMIN,
  ]) {
    it(`allows ${role} to view the requested dossier`, async () => {
      await withAuthApp(async (fixture, app) => {
        await fixture.passports.upsertPassport(TEST_USER_ID, {
          ...profileInput,
          isScoutSearchable: true,
        });
        assert.ok(fixture.state.profile);
        fixture.state.profile.userId = TEST_OTHER_ID;
        fixture.state.user.role = role;
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/users/${TEST_OTHER_ID}/dossier`,
          headers: authenticatedHeaders(),
        });
        assert.strictEqual(response.statusCode, 200, response.body);
        assert.strictEqual(
          response.json<StandardApiResponse<AthleteDossierResponse>>().data.athlete_id,
          TEST_OTHER_ID,
        );
      });
    });
  }

  it('enforces scout opt-out on dossiers, legacy passports, and outreach while allowing admins', async () => {
    await withAuthApp(async (fixture, app) => {
      await fixture.passports.upsertPassport(TEST_USER_ID, {
        ...profileInput,
        isScoutSearchable: false,
      });
      assert.ok(fixture.state.profile);
      fixture.state.profile.userId = TEST_OTHER_ID;
      fixture.state.user.role = UserRole.SCOUT;
      for (const url of [
        `/api/v1/users/${TEST_OTHER_ID}/dossier`,
        `/api/v1/passport/${TEST_OTHER_ID}`,
        `/api/v1/passport/${TEST_OTHER_ID}/sports`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: authenticatedHeaders() });
        assert.strictEqual(response.statusCode, 403, response.body);
        assert.match(response.body, /not opted into scout discovery/);
      }
      const outreach = await app.inject({
        method: 'POST',
        url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
        headers: authenticatedHeaders(),
        payload: { notes: 'Trial invitation' },
      });
      assert.strictEqual(outreach.statusCode, 403, outreach.body);
      assert.strictEqual(fixture.state.dossiers.size, 0);
      fixture.state.user.role = UserRole.FEDERATION_ADMIN;
      assert.strictEqual(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/users/${TEST_OTHER_ID}/dossier`,
            headers: authenticatedHeaders(),
          })
        ).statusCode,
        200,
      );
    });
  });

  it('denies other athletes access to dossiers and denies athlete/organizer outreach', async () => {
    await withAuthApp(async (fixture, app) => {
      await fixture.passports.upsertPassport(TEST_USER_ID, {
        ...profileInput,
        isScoutSearchable: true,
      });
      assert.strictEqual(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/users/${TEST_OTHER_ID}/dossier`,
            headers: authenticatedHeaders(),
          })
        ).statusCode,
        403,
      );
      for (const role of [UserRole.ATHLETE, UserRole.ORGANIZER]) {
        fixture.state.user.role = role;
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
          headers: authenticatedHeaders(),
          payload: { notes: 'Trial' },
        });
        assert.strictEqual(response.statusCode, 403, response.body);
      }
    });
  });

  it('upserts trial/scholarship outreach and replays an identical request without duplicating records', async () => {
    await withAuthApp(async (fixture, app) => {
      await fixture.passports.upsertPassport(TEST_USER_ID, {
        ...profileInput,
        isScoutSearchable: true,
      });
      assert.ok(fixture.state.profile);
      fixture.state.profile.userId = TEST_OTHER_ID;
      fixture.state.user.role = UserRole.SCOUT;
      const key = randomUUID();
      const payload = { scout_notes: 'Attend campus trial', outreach_type: 'TRIAL' };
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
        headers: authenticatedHeaders(key),
        payload,
      });
      assert.strictEqual(first.statusCode, 201, first.body);
      const repeated = await app.inject({
        method: 'POST',
        url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
        headers: authenticatedHeaders(key),
        payload,
      });
      assert.strictEqual(repeated.statusCode, 201, repeated.body);
      assert.strictEqual(repeated.headers['x-cache-lookup'], 'IDEMPOTENT_HIT');
      assert.strictEqual(fixture.state.dossiers.size, 1);
      fixture.state.profile.isScoutSearchable = false;
      const afterOptOut = await app.inject({
        method: 'POST',
        url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
        headers: authenticatedHeaders(key),
        payload,
      });
      assert.strictEqual(afterOptOut.statusCode, 403, afterOptOut.body);
      fixture.state.profile.isScoutSearchable = true;
      const update = await app.inject({
        method: 'POST',
        url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
        headers: authenticatedHeaders(),
        payload: { notes: 'Scholarship offer', outreachType: 'SCHOLARSHIP' },
      });
      assert.strictEqual(update.statusCode, 201, update.body);
      assert.strictEqual(fixture.state.dossiers.size, 1);
      assert.strictEqual(
        [...fixture.state.dossiers.values()][0]?.pipelineStatus,
        'SCHOLARSHIP_OUTREACH',
      );
      assert.strictEqual([...fixture.state.dossiers.values()][0]?.scoutNotes, 'Scholarship offer');
    });
  });

  it('accepts Supabase JWT claims and keeps database roles authoritative over user metadata', async () => {
    await withAuthApp(async (fixture, app) => {
      fixture.state.user.role = UserRole.SCOUT;
      const token = sign(
        {
          sub: TEST_USER_ID,
          role: 'authenticated',
          email: 'scout@supabase.test',
          phone: '+919000000001',
          user_metadata: { role: 'SCOUT' },
        },
        SUPABASE_TEST_SECRET,
        { algorithm: 'HS256', expiresIn: 900 },
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authenticatedHeaders(randomUUID(), token),
      });
      assert.strictEqual(response.statusCode, 200, response.body);
      assert.strictEqual(
        response.json<StandardApiResponse<{ readonly role: string; readonly email: string }>>().data
          .role,
        'SCOUT',
      );
      assert.strictEqual(
        response.json<StandardApiResponse<{ readonly email: string }>>().data.email,
        'scout@supabase.test',
      );
      fixture.state.user.role = UserRole.ATHLETE;
      const malicious = sign(
        { sub: TEST_USER_ID, role: 'authenticated', user_metadata: { role: 'SUPER_ADMIN' } },
        SUPABASE_TEST_SECRET,
        { algorithm: 'HS256', expiresIn: 900 },
      );
      const limited = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authenticatedHeaders(randomUUID(), malicious),
      });
      assert.strictEqual(limited.statusCode, 200, limited.body);
      assert.strictEqual(
        limited.json<StandardApiResponse<{ readonly role: string }>>().data.role,
        'ATHLETE',
      );
      const forbidden = await app.inject({
        method: 'POST',
        url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
        headers: authenticatedHeaders(randomUUID(), malicious),
        payload: { notes: 'Unauthorized offer' },
      });
      assert.strictEqual(forbidden.statusCode, 403, forbidden.body);
    });
  });

  it('rechecks stored roles and deactivation for an already-issued JWT before replaying mutations', async () => {
    await withAuthApp(async (fixture, app) => {
      await fixture.passports.upsertPassport(TEST_USER_ID, profileInput);
      assert.ok(fixture.state.profile);
      fixture.state.profile.userId = TEST_OTHER_ID;
      fixture.state.user.role = UserRole.SUPER_ADMIN;
      const key = randomUUID();
      const token = fixtureToken(UserRole.SUPER_ADMIN);
      const request = {
        method: 'POST' as const,
        url: `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`,
        headers: authenticatedHeaders(key, token),
        payload: { notes: 'Campus trial' },
      };
      const first = await app.inject(request);
      assert.strictEqual(first.statusCode, 201, first.body);
      fixture.state.user.role = UserRole.ATHLETE;
      assert.strictEqual((await app.inject(request)).statusCode, 403);
      fixture.state.user.isActive = false;
      assert.strictEqual(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: authenticatedHeaders(key, token),
          })
        ).statusCode,
        403,
      );
      assert.strictEqual(fixture.state.dossiers.size, 1);
    });
  });

  it('rejects expired, wrong-key, unsupported-algorithm, missing-expiry, and malformed-subject JWTs', async () => {
    await withAuthApp(async (_fixture, app) => {
      const payload = { sub: TEST_USER_ID, role: 'ATHLETE' };
      for (const token of [
        sign(payload, TEST_SECRET, { expiresIn: -1 }),
        sign(payload, 'incorrect-key', { expiresIn: 900 }),
        sign(payload, TEST_SECRET, { algorithm: 'HS512', expiresIn: 900 }),
        sign(payload, TEST_SECRET),
        sign({ ...payload, sub: 'not-a-uuid' }, TEST_SECRET, { expiresIn: 900 }),
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: authenticatedHeaders(randomUUID(), token),
        });
        assert.strictEqual(response.statusCode, 401, response.body);
      }
    });
  });

  it('supports RSA and Supabase tokens together without RSA/HMAC key confusion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kheleo-phase2-keys-'));
    try {
      const keys = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const privatePath = join(directory, 'private.pem');
      const publicPath = join(directory, 'public.pem');
      writeFileSync(privatePath, keys.privateKey);
      writeFileSync(publicPath, keys.publicKey);
      const fixture = createAuthFixture({
        config: { 'auth.jwtPrivateKeyPath': privatePath, 'auth.jwtPublicKeyPath': publicPath },
      });
      await withAuthApp(async (_fixture, app) => {
        for (const token of [
          sign({ sub: TEST_USER_ID, role: 'ATHLETE' }, keys.privateKey, {
            algorithm: 'RS256',
            expiresIn: 900,
          }),
          sign({ sub: TEST_USER_ID, role: 'authenticated' }, SUPABASE_TEST_SECRET, {
            expiresIn: 900,
          }),
        ]) {
          const response = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: authenticatedHeaders(randomUUID(), token),
          });
          assert.strictEqual(response.statusCode, 200, response.body);
        }
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
          'base64url',
        );
        const payload = Buffer.from(
          JSON.stringify({
            sub: TEST_USER_ID,
            role: 'SUPER_ADMIN',
            exp: Math.floor(Date.now() / 1000) + 900,
          }),
        ).toString('base64url');
        const signature = createHmac('sha256', keys.publicKey)
          .update(`${header}.${payload}`)
          .digest('base64url');
        assert.strictEqual(
          (
            await app.inject({
              method: 'GET',
              url: '/api/v1/auth/me',
              headers: authenticatedHeaders(randomUUID(), `${header}.${payload}.${signature}`),
            })
          ).statusCode,
          401,
        );
      }, fixture);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enforces verified identity and completed passports before bracket or pool entry', async () => {
    const fixture = createAuthFixture();
    const brackets = new BracketsService(fixture.database);
    const matchmaking = new MatchmakingService(
      fixture.database,
      {} as QueueProducerService,
      {} as MatchmakingGateway,
    );
    await fixture.passports.upsertPassport(TEST_USER_ID, profileInput);
    for (const status of [
      null,
      VerificationStatus.UNVERIFIED,
      VerificationStatus.REVOKED,
      VerificationStatus.FLAGGED_DUPLICATE,
    ]) {
      if (status === null) fixture.state.user.identityRecord = null;
      else {
        fixture.state.user.identityRecord = {
          id: randomUUID(),
          userId: TEST_USER_ID,
          idHash: '',
          idType: GovIdType.AADHAAR,
          saltVersion: 1,
          status,
          reLinkedCount: 0,
          historicalUserIds: [],
          verifiedAt: new Date(),
          metadata: null,
        };
      }
      await assert.rejects(
        brackets.registerForBracket(randomUUID(), randomUUID(), TEST_USER_ID, {}),
        (error: unknown) => error instanceof Error && error.name === 'ForbiddenException',
      );
      await assert.rejects(
        matchmaking.joinPool(randomUUID(), randomUUID(), TEST_USER_ID, { primary_role: 'BOWLER' }),
        (error: unknown) => error instanceof Error && error.name === 'ForbiddenException',
      );
    }
    assert.ok(fixture.state.user.identityRecord);
    fixture.state.user.identityRecord.status = VerificationStatus.VERIFIED;
    assert.ok(fixture.state.profile);
    fixture.state.profile.primarySport = null;
    await assert.rejects(
      brackets.registerForBracket(randomUUID(), randomUUID(), TEST_USER_ID, {}),
      BadRequestException,
    );
    await assert.rejects(
      matchmaking.joinPool(randomUUID(), randomUUID(), TEST_USER_ID, { primary_role: 'BOWLER' }),
      BadRequestException,
    );
  });
});

const tournamentPayload = {
  name: 'Campus Final',
  sport: 'CRICKET',
  min_gti: 10,
  max_gti: 80,
  max_teams: 8,
  team_size: 4,
  prize_pool: 1000,
  venue_name: 'Campus Ground',
  venue_lat: 19,
  venue_lng: 72,
  registration_deadline: '2099-01-01T00:00:00Z',
  start_date: '2099-01-02T00:00:00Z',
  end_date: '2099-01-03T00:00:00Z',
};
const bracketPayload = {
  name: 'Silver',
  tier_name: 'SILVER',
  min_gti: 30,
  max_gti: 70,
  entry_fee: 0,
  max_teams: 8,
};

type CompetitionFixture = ReturnType<typeof createCompetitionFixture>;
async function withCompetitionApp(
  operation: (fixture: CompetitionFixture, app: NestFastifyApplication) => Promise<void>,
): Promise<void> {
  const fixture = createCompetitionFixture();
  fixture.auth.state.user.role = UserRole.ORGANIZER;
  const app = await createCompetitionApp(fixture);
  try {
    await operation(fixture, app);
  } finally {
    await app.close();
  }
}

async function seedTeam(
  fixture: CompetitionFixture,
  scores: readonly number[] = [50, 50, 50, 50],
  captainId: string | null = TEST_USER_ID,
  memberCaptain = false,
): Promise<string> {
  const team = await fixture.prisma.team.create({
    data: { name: 'Campus XI', tournamentId: TOURNAMENT_ID, captainId, averageGti: 50 },
  });
  for (const [index, score] of scores.entries()) {
    const userId = index === 0 ? TEST_USER_ID : randomUUID();
    const profile = {
      ...fixture.state.profiles.get(TEST_USER_ID)!,
      id: randomUUID(),
      userId,
      currentGti: new Prisma.Decimal(score),
    };
    fixture.state.profiles.set(userId, profile);
    await fixture.prisma.teamMember.create({
      data: {
        teamId: team.id,
        userId,
        athleteId: profile.id,
        isCaptain: index === 0 && memberCaptain,
      },
    });
  }
  return team.id;
}

describe('Phase 3 organizer CRUD, transactional eligibility, and spatial regressions', () => {
  it("rejects organizer creation of a bracket in another organizer's tournament with HTTP 403", async () => {
    await withCompetitionApp(async (fixture, app) => {
      fixture.state.tournaments.get(TOURNAMENT_ID)!.organizerId = OTHER_OWNER_ID;
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tournaments/${TOURNAMENT_ID}/brackets`,
        headers: authenticatedHeaders(),
        payload: bracketPayload,
      });

      assert.strictEqual(response.statusCode, 403, response.body);
      assert.match(response.body, /You do not own this tournament/);
      assert.strictEqual(fixture.state.brackets.size, 1);
    });
  });

  it('supports owner tournament/bracket create, update, listing, and delete with snake_case DTOs', async () => {
    await withCompetitionApp(async (fixture, app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/tournaments',
        headers: authenticatedHeaders(),
        payload: tournamentPayload,
      });
      assert.strictEqual(created.statusCode, 201, created.body);
      const tournament = created.json<StandardApiResponse<Tournament>>().data;
      assert.strictEqual(tournament.organizerId, TEST_USER_ID);
      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tournaments/${tournament.id}`,
        headers: authenticatedHeaders(),
        payload: { prizePool: 2000, maxTeams: 10 },
      });
      assert.strictEqual(updated.statusCode, 200, updated.body);
      assert.strictEqual(
        Number(updated.json<StandardApiResponse<Tournament>>().data.prizePool),
        2000,
      );
      const bracket = await app.inject({
        method: 'POST',
        url: `/api/v1/tournaments/${tournament.id}/brackets`,
        headers: authenticatedHeaders(),
        payload: bracketPayload,
      });
      assert.strictEqual(bracket.statusCode, 201, bracket.body);
      const bracketId = bracket.json<StandardApiResponse<{ readonly id: string }>>().data.id;
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tournaments/${tournament.id}/brackets/${bracketId}`,
        headers: authenticatedHeaders(),
        payload: { minGti: 35, maxGti: 75, entryFee: 10 },
      });
      assert.strictEqual(patched.statusCode, 200, patched.body);
      assert.strictEqual(
        Number(patched.json<StandardApiResponse<{ readonly minGti: number }>>().data.minGti),
        35,
      );
      assert.strictEqual(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/tournaments/${tournament.id}/brackets/${bracketId}`,
            headers: authenticatedHeaders(),
          })
        ).statusCode,
        200,
      );
      assert.strictEqual(fixture.state.brackets.has(bracketId), false);
      assert.strictEqual(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/tournaments/${tournament.id}`,
            headers: authenticatedHeaders(),
          })
        ).statusCode,
        200,
      );
      assert.strictEqual(fixture.state.tournaments.has(tournament.id), false);
    });
  });

  it('enforces ownership on every tournament/bracket mutation and permits both administrator roles', async () => {
    await withCompetitionApp(async (fixture, app) => {
      fixture.state.tournaments.get(TOURNAMENT_ID)!.organizerId = OTHER_OWNER_ID;
      const requests = [
        {
          method: 'PATCH' as const,
          url: `/api/v1/tournaments/${TOURNAMENT_ID}`,
          payload: { name: 'Changed' },
        },
        { method: 'DELETE' as const, url: `/api/v1/tournaments/${TOURNAMENT_ID}` },
        {
          method: 'PATCH' as const,
          url: `/api/v1/tournaments/${TOURNAMENT_ID}/brackets/${BRACKET_ID}`,
          payload: { name: 'Changed' },
        },
        {
          method: 'DELETE' as const,
          url: `/api/v1/tournaments/${TOURNAMENT_ID}/brackets/${BRACKET_ID}`,
        },
      ];
      for (const request of requests) {
        const response = await app.inject({ ...request, headers: authenticatedHeaders() });
        assert.strictEqual(response.statusCode, 403, response.body);
        assert.match(response.body, /You do not own this tournament/);
      }
      for (const role of [UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN]) {
        fixture.auth.state.user.role = role;
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/tournaments/${TOURNAMENT_ID}`,
          headers: authenticatedHeaders(),
          payload: { name: `Managed by ${role}` },
        });
        assert.strictEqual(response.statusCode, 200, response.body);
      }
      assert.ok(
        fixture.state.reads
          .filter((entry) => entry.model === 'tournament')
          .every((entry) => entry.inTransaction),
      );
    });
  });

  it('filters tournament lists and advances deterministic UUID cursors without duplicates', async () => {
    await withCompetitionApp(async (fixture, app) => {
      const secondId = '55555555-5555-4555-8555-555555555555';
      fixture.state.tournaments.set(secondId, makeTournament({ id: secondId }));
      fixture.state.tournaments.set(
        OTHER_OWNER_ID,
        makeTournament({ id: OTHER_OWNER_ID, organizerId: OTHER_OWNER_ID }),
      );
      const draftId = randomUUID();
      fixture.state.tournaments.set(draftId, makeTournament({ id: draftId, status: 'DRAFT' }));
      const url = `/api/v1/tournaments?sport=CRICKET&status=REGISTRATION_OPEN&organizer_id=${TEST_USER_ID}&limit=1`;
      const first = await app.inject({ method: 'GET', url });
      assert.strictEqual(first.statusCode, 200, first.body);
      const page1 = first.json<StandardApiResponse<PaginatedResponseDto<Tournament>>>().data;
      assert.deepStrictEqual(
        page1.data.map((row) => row.id),
        [TOURNAMENT_ID],
      );
      assert.strictEqual(page1.has_more, true);
      assert.strictEqual(page1.next_cursor, TOURNAMENT_ID);
      const second = await app.inject({
        method: 'GET',
        url: `${url}&cursor_id=${page1.next_cursor}`,
      });
      const page2 = second.json<StandardApiResponse<PaginatedResponseDto<Tournament>>>().data;
      assert.deepStrictEqual(
        page2.data.map((row) => row.id),
        [secondId],
      );
      assert.strictEqual(page2.has_more, false);
    });
  });

  it('rejects invalid tournament invariants and validates PATCH values against persisted fields', async () => {
    await withCompetitionApp(async (fixture, app) => {
      for (const overrides of [
        { min_gti: -1 },
        { max_gti: 101 },
        { min_gti: 80, max_gti: 20 },
        { prize_pool: -1 },
        { max_teams: 1 },
        { team_size: 0 },
        { team_size: 31 },
        { venue_lat: 91 },
        { venue_lng: -181 },
        { start_date: 'not-a-date' },
        { start_date: '2099-02-30' },
        { registration_deadline: '2099-01-04' },
        { end_date: '2099-01-01' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/tournaments',
          headers: authenticatedHeaders(),
          payload: { ...tournamentPayload, ...overrides },
        });
        assert.strictEqual(response.statusCode, 400, response.body);
      }
      fixture.state.tournaments.get(TOURNAMENT_ID)!.maxGti = new Prisma.Decimal(60);
      for (const payload of [
        { min_gti: 70 },
        { min_gti: null },
        { team_size: null },
        { registration_deadline: '2099-01-04' },
        { end_date: '2098-12-31' },
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/tournaments/${TOURNAMENT_ID}`,
          headers: authenticatedHeaders(),
          payload,
        });
        assert.strictEqual(response.statusCode, 400, response.body);
      }
      assert.strictEqual(fixture.state.tournaments.size, 1);
    });
  });

  it('enforces bracket GTI/fee/capacity invariants on create and partial update', async () => {
    await withCompetitionApp(async (_fixture, app) => {
      for (const overrides of [
        { min_gti: -1 },
        { max_gti: 101 },
        { min_gti: 80, max_gti: 20 },
        { entry_fee: -1 },
        { max_teams: 1 },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/tournaments/${TOURNAMENT_ID}/brackets`,
          headers: authenticatedHeaders(),
          payload: { ...bracketPayload, ...overrides },
        });
        assert.strictEqual(response.statusCode, 400, response.body);
      }
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tournaments/${TOURNAMENT_ID}/brackets/${BRACKET_ID}`,
        headers: authenticatedHeaders(),
        payload: { min_gti: 70 },
      });
      assert.strictEqual(response.statusCode, 400, response.body);
      const anonymous = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tournaments/${TOURNAMENT_ID}`,
        payload: { name: 'Anonymous change' },
      });
      assert.strictEqual(anonymous.statusCode, 401);
    });
  });

  for (const change of ['gti', 'identity', 'deadline', 'bracket-bounds'] as const) {
    it(`re-reads ${change} on registration retries and rolls back the first attempt`, async () => {
      const fixture = createCompetitionFixture();
      fixture.state.failNextCommit = true;
      fixture.state.onBegin = (attempt) => {
        if (attempt !== 2) return;
        if (change === 'gti')
          fixture.state.profiles.get(TEST_USER_ID)!.currentGti = new Prisma.Decimal(90);
        if (change === 'identity')
          fixture.state.profiles.get(TEST_USER_ID)!.user.identityRecord!.status =
            VerificationStatus.REVOKED;
        if (change === 'deadline')
          fixture.state.tournaments.get(TOURNAMENT_ID)!.registrationDeadline = new Date(
            '2000-01-01',
          );
        if (change === 'bracket-bounds')
          fixture.state.brackets.get(BRACKET_ID)!.maxGti = new Prisma.Decimal(45);
      };
      await assert.rejects(
        fixture.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {}),
        (error: unknown) => {
          if (change === 'identity') assert.ok(error instanceof ForbiddenException);
          else if (change === 'deadline') {
            assert.ok(error instanceof BadRequestException);
            assert.match(error.message, /deadline/);
          } else {
            assert.ok(error instanceof ConflictException);
            assert.strictEqual(
              (error.getResponse() as Record<string, unknown>).code,
              'SANDBAGGING_DETECTED',
            );
          }
          return true;
        },
      );
      assert.strictEqual(fixture.state.transactions, 2);
      assert.strictEqual(fixture.state.registrations.size, 0);
      assert.strictEqual(
        fixture.state.reads.filter((entry) => entry.model === 'profile').length,
        2,
      );
      assert.ok(fixture.state.reads.every((entry) => entry.inTransaction));
    });
  }

  it('does not suggest a bracket whose minimum GTI is higher than the athlete score', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.profiles.get(TEST_USER_ID)!.currentGti = new Prisma.Decimal(82);
    const id = randomUUID();
    fixture.state.brackets.set(id, {
      ...fixture.state.brackets.get(BRACKET_ID)!,
      id,
      minGti: new Prisma.Decimal(90),
      maxGti: new Prisma.Decimal(100),
    });
    for (const execute of [
      () =>
        fixture.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {}),
      () =>
        fixture.services.matchmaking.joinPool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
          primary_role: 'BATSMAN',
        }),
    ]) {
      await assert.rejects(execute(), (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        const response = error.getResponse() as Record<string, unknown>;
        assert.strictEqual(response.code, 'SANDBAGGING_DETECTED');
        assert.strictEqual(response.suggestedBracketId, null);
        assert.strictEqual(response.suggestedBracketTier, null);
        return true;
      });
    }
  });

  it('validates team captain ownership and uses live roster GTI rather than a stale team average', async () => {
    const fixture = createCompetitionFixture();
    const foreignCaptain = await seedTeam(fixture, [50, 50, 50, 50], OTHER_OWNER_ID);
    await assert.rejects(
      fixture.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
        teamId: foreignCaptain,
      }),
      /Only the team captain/,
    );
    const highTeam = await seedTeam(fixture, [50, 100, 100, 100]);
    await assert.rejects(
      fixture.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
        teamId: highTeam,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.strictEqual((error.getResponse() as Record<string, unknown>).teamGti, 87.5);
        return true;
      },
    );
    assert.strictEqual(fixture.state.registrations.size, 0);
  });

  it('allows a member captain to register a valid roster and rejects teams from another tournament', async () => {
    const fixture = createCompetitionFixture();
    const teamId = await seedTeam(fixture, [50, 45, 55, 50], null, true);
    const result = await fixture.services.brackets.registerForBracket(
      TOURNAMENT_ID,
      BRACKET_ID,
      TEST_USER_ID,
      { teamId },
    );
    assert.strictEqual(result.teamId, teamId);
    assert.strictEqual(fixture.state.teams.get(teamId)?.averageGti, 50);
    fixture.state.teams.get(teamId)!.tournamentId = OTHER_OWNER_ID;
    await assert.rejects(
      fixture.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
        teamId,
      }),
      /does not belong/,
    );
  });

  it('paginates all bounding-box candidates in the fallback so nearby rows beyond a UUID prefix are retained', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.tournaments.clear();
    for (let index = 0; index < 205; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
      fixture.state.tournaments.set(id, makeTournament({ id, venueLat: 0.8, venueLng: 0.8 }));
    }
    const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    fixture.state.tournaments.set(id, makeTournament({ id, venueLat: 0, venueLng: 0.1 }));
    const rows = await fixture.services.tournaments.findNearby({
      lat: 0,
      lng: 0,
      radius_km: 100,
      limit: 1,
    });
    assert.deepStrictEqual(
      rows.data.map((row) => row.id),
      [id],
    );
    const reads = fixture.state.reads.filter((entry) => entry.model === 'tournament');
    assert.strictEqual(reads.length, 2);
    assert.ok(
      reads.every(
        (entry) =>
          entry.args.where?.venueLat !== undefined && entry.args.where.venueLng !== undefined,
      ),
    );
  });

  it('applies distance/UUID ordering to Haversine cursors rather than filtering by UUID alone', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.tournaments.clear();
    const locations = [
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', lng: 0 },
      { id: '99999999-9999-4999-8999-999999999999', lng: 0 },
      { id: '00000000-0000-4000-8000-000000000001', lng: 0.1 },
    ];
    for (const location of locations)
      fixture.state.tournaments.set(
        location.id,
        makeTournament({ id: location.id, venueLat: 0, venueLng: location.lng }),
      );
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const rows = await fixture.services.tournaments.findNearby({
        lat: 0,
        lng: 0,
        radius_km: 50,
        limit: 1,
        cursor,
      });
      ids.push(...rows.data.map((row) => row.id));
      if (!rows.data[0]) break;
      cursor = rows.data[0].id;
    }
    assert.deepStrictEqual(ids, [locations[1]!.id, locations[0]!.id, locations[2]!.id]);
    await assert.rejects(
      fixture.services.tournaments.findNearby({
        lat: 0,
        lng: 0,
        radius_km: 50,
        limit: 1,
        cursor: randomUUID(),
      }),
      BadRequestException,
    );
  });

  it('uses conservative bounding boxes across the antimeridian and near the poles', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.tournaments.clear();
    const first = randomUUID();
    const second = randomUUID();
    fixture.state.tournaments.set(
      first,
      makeTournament({ id: first, venueLat: 0, venueLng: 179.9 }),
    );
    fixture.state.tournaments.set(
      second,
      makeTournament({ id: second, venueLat: 0, venueLng: -179.9 }),
    );
    const rows = await fixture.services.tournaments.findNearby({
      lat: 0,
      lng: 179.95,
      radius_km: 50,
      limit: 20,
    });
    assert.strictEqual(rows.data.length, 2);
    const box = geographicBoundingBox({ lat: 89.9, lng: 0 }, 50);
    assert.strictEqual(box.allLongitudes, true);
    assert.strictEqual(box.maxLat, 90);
    assert.ok(haversineDistance({ lat: 0, lng: 179.9 }, 0, -179.9) < 25);
  });
});

// Phase 4 uses actual HTTP controllers and Socket.IO transports with explicit dependency doubles.
import {
  createSecurityFixture,
  createSecurityApp,
  ATHLETE_ID,
  OPPONENT_ID,
  ORGANIZER_ID,
  UMPIRE_ID,
  SUPER_ID,
  SCOUT_ID,
  MATCH_ID,
} from './helpers/security-gti.fixture';
import { createSocketFixture, deadline } from './helpers/socket.fixture';
import { AutonomousMatchPausePayload } from '../src/infrastructure/realtime/ws-event.gateway';
import {
  AuthenticatedNamespace,
  AuthenticatedSocket,
} from '../src/infrastructure/realtime/ws-auth.guard';
import { RoomAccessService } from '../src/infrastructure/realtime/room-access.service';
import { AdminService } from '../src/modules/admin/admin.service';
import { HealthService } from '../src/modules/health/health.service';
import { sign as signSocketToken } from 'jsonwebtoken';

const medicalEvent: AutonomousMatchPausePayload = {
  event: 'MATCH_PAUSE_ALERT',
  severity: 'CRITICAL',
  athlete_id: ATHLETE_ID,
  athlete_name: 'Private athlete',
  vitals: { heart_rate: 205, spo2: 88, skin_temperature: 40 },
  directive: 'MANDATORY REST',
  match_id: MATCH_ID,
};

describe('Phase 4 authenticated sockets and administrative controls', () => {
  it('Probe 5: rejects anonymous and invalid handshakes on both namespaces before any medical delivery', async () => {
    const f = await createSecurityFixture();
    const sockets = await createSocketFixture(f);
    try {
      for (const path of ['/ws/events', '/ws/matchmaking'])
        for (const token of [undefined, 'invalid-token']) {
          const anonymous = sockets.client(path, token);
          let received = 0;
          anonymous.on('MATCH_PAUSE_ALERT', () => {
            received++;
          });
          await deadline(
            new Promise<void>((resolve, reject) => {
              anonymous.once('connect_error', () => resolve());
              anonymous.once('connect', () => reject(new Error('Anonymous socket connected')));
              anonymous.connect();
            }),
          );
          assert.strictEqual(anonymous.connected, false);
          sockets.events.broadcastAutonomousMatchPause(medicalEvent);
          assert.strictEqual(received, 0);
          assert.strictEqual(sockets.ioServer.of(path).sockets.size, 0);
        }
      let disconnects = 0;
      const fake = {
        handshake: { auth: {}, headers: {}, query: {} },
        data: {},
        disconnect: (close: boolean) => {
          assert.strictEqual(close, true);
          disconnects++;
        },
      } as unknown as AuthenticatedSocket;
      await sockets.events.handleConnection(fake);
      await sockets.matchmaking.handleConnection(fake);
      assert.strictEqual(disconnects, 2);
    } finally {
      await sockets.close();
    }
  });

  it('authenticates auth/header/query tokens, attaches DB roles and auto rooms, and routes scout alerts only to scouts', async () => {
    const f = await createSecurityFixture();
    const sockets = await createSocketFixture(f);
    try {
      for (const mechanism of ['auth', 'header', 'query'] as const) {
        const client = sockets.client('/ws/events', f.token(SCOUT_ID), mechanism);
        await sockets.connect(client);
        const server = sockets.serverSocket(client);
        assert.strictEqual(server.data.user?.sub, SCOUT_ID);
        assert.ok(server.rooms.has('scouts'));
        assert.ok(server.rooms.has('role:SCOUT'));
        assert.ok(server.rooms.has(`user:${SCOUT_ID}`));
        client.disconnect();
      }
      const scout = sockets.client('/ws/events', f.token(SCOUT_ID));
      const athlete = sockets.client('/ws/events', f.token());
      await sockets.connect(scout);
      await sockets.connect(athlete);
      let athleteAlerts = 0;
      athlete.on('SCOUT_TALENT_ALERT', () => {
        athleteAlerts++;
      });
      const received = deadline(
        new Promise<unknown>((resolve) => scout.once('SCOUT_TALENT_ALERT', resolve)),
      );
      sockets.events.broadcastScoutTalent({
        athleteId: ATHLETE_ID,
        newGti: 90,
        sport: 'CRICKET',
        district: 'Pune',
        state: 'Maharashtra',
        tierClassification: 'RURAL',
      });
      await received;
      assert.strictEqual(athleteAlerts, 0);
      const forged = sockets.client(
        '/ws/events',
        signSocketToken({ sub: ATHLETE_ID, role: 'SUPER_ADMIN' }, TEST_SECRET, { expiresIn: 60 }),
      );
      await sockets.connect(forged);
      assert.strictEqual(sockets.serverSocket(forged).rooms.has('scouts'), false);
      assert.strictEqual(sockets.serverSocket(forged).data.user?.role, 'ATHLETE');
    } finally {
      await sockets.close();
    }
  });

  it('blocks arbitrary match subscriptions and delivers a safety alert once to an authorized socket in overlapping rooms', async () => {
    const f = await createSecurityFixture();
    const sockets = await createSocketFixture(f);
    try {
      f.state.tables.user.get(SCOUT_ID)!.role = 'ORGANIZER';
      const unrelated = sockets.client('/ws/events', f.token(SCOUT_ID));
      await sockets.connect(unrelated);
      let unrelatedEvents = 0;
      unrelated.on('MATCH_PAUSE_ALERT', () => {
        unrelatedEvents++;
      });
      f.state.tables.user.get(SCOUT_ID)!.role = 'SCOUT';
      const own = sockets.client('/ws/events', f.token());
      const opponent = sockets.client('/ws/events', f.token(OPPONENT_ID));
      const scout = sockets.client('/ws/events', f.token(SCOUT_ID));
      await sockets.connect(own);
      await sockets.connect(opponent);
      await sockets.connect(scout);
      const ownServer = sockets.serverSocket(own),
        scoutServer = sockets.serverSocket(scout);
      await assert.rejects(
        sockets.events.handleJoinMatch(scoutServer, { matchId: MATCH_ID }),
        ForbiddenException,
      );
      assert.strictEqual(scoutServer.rooms.has(`match:${MATCH_ID}`), false);
      await sockets.events.handleJoinAthlete(scoutServer, { athleteId: ATHLETE_ID });
      assert.strictEqual(scoutServer.rooms.has(`athlete:${ATHLETE_ID}`), false);
      await sockets.events.handleJoinMatch(ownServer, { matchId: MATCH_ID });
      await sockets.events.handleJoinBracket(ownServer, { bracketId: BRACKET_ID });
      await sockets.events.handleJoinTournament(ownServer, { tournamentId: TOURNAMENT_ID });
      assert.ok(ownServer.rooms.has(`match:${MATCH_ID}`));
      assert.ok(ownServer.rooms.has(`bracket:${BRACKET_ID}`));
      assert.ok(ownServer.rooms.has(`tournament:${TOURNAMENT_ID}`));
      await assert.rejects(
        sockets.events.handleJoinTournament(scoutServer, { tournamentId: TOURNAMENT_ID }),
        ForbiddenException,
      );
      await assert.rejects(
        sockets.events.handleJoinBracket(ownServer, { bracketId: randomUUID() }),
        ForbiddenException,
      );
      const staff = sockets.client('/ws/events', f.token(ORGANIZER_ID));
      await sockets.connect(staff);
      const staffServer = sockets.serverSocket(staff);
      await sockets.events.handleJoinMatch(staffServer, { matchId: MATCH_ID });
      await sockets.events.handleJoinBracket(staffServer, { bracketId: BRACKET_ID });
      assert.strictEqual(staffServer.rooms.has(`match:${MATCH_ID}`), true);
      let staffEvents = 0;
      staff.on('MATCH_PAUSE_ALERT', () => {
        staffEvents++;
      });
      const staffReceived = deadline(
        new Promise<unknown>((resolve) => staff.once('MATCH_PAUSE_ALERT', resolve)),
      );
      let ownEvents = 0,
        scoutEvents = 0,
        opponentEvents = 0;
      own.on('MATCH_PAUSE_ALERT', () => {
        ownEvents++;
      });
      scout.on('MATCH_PAUSE_ALERT', () => {
        scoutEvents++;
      });
      opponent.on('MATCH_PAUSE_ALERT', () => {
        opponentEvents++;
      });

      sockets.events.broadcastAutonomousMatchPause(medicalEvent);
      await staffReceived;
      assert.strictEqual(staffEvents, 1);
      // A server roundtrip is a deterministic delivery barrier, without timing sleeps.
      const ack = deadline(new Promise<void>((resolve) => own.once('barrier', () => resolve())));
      ownServer.emit('barrier');
      await ack;
      assert.strictEqual(ownEvents, 0);
      assert.strictEqual(scoutEvents, 0);
      assert.strictEqual(opponentEvents, 0);
      assert.strictEqual(unrelatedEvents, 0);
    } finally {
      await sockets.close();
    }
  });

  it('uses Socket.IO room unions so ROSTER_FORMED reaches an overlapping user/bracket subscriber once', async () => {
    const f = await createSecurityFixture();
    const sockets = await createSocketFixture(f);
    try {
      const client = sockets.client('/ws/matchmaking', f.token());
      await sockets.connect(client);
      const server = sockets.serverSocket(client, '/ws/matchmaking');
      await server.join('bracket:fixture');
      let events = 0;
      client.on('ROSTER_FORMED', () => {
        events++;
      });
      const received = deadline(
        new Promise<unknown>((resolve) => client.once('ROSTER_FORMED', resolve)),
      );
      sockets.matchmaking.emitRosterFormed({
        team_id: 'team',
        team_name: 'Team',
        bracket_id: 'fixture',
        roster: [{ user_id: ATHLETE_ID, name: 'Athlete', assigned_role: 'BATSMAN', gti: 90 }],
      });
      await received;
      const barrier = deadline(
        new Promise<void>((resolve) => client.once('barrier', () => resolve())),
      );
      server.emit('barrier');
      await barrier;
      assert.strictEqual(events, 1);
    } finally {
      await sockets.close();
    }
  });

  it('rejects deactivated/revoked accounts during handshakes and disconnects existing rooms on admin status changes', async () => {
    const f = await createSecurityFixture();
    const sockets = await createSocketFixture(f);
    try {
      const client = sockets.client('/ws/events', f.token());
      await sockets.connect(client);
      const disconnected = deadline(
        new Promise<void>((resolve) => client.once('disconnect', () => resolve())),
      );
      const admin = new AdminService(
        f.prisma,
        new HealthService(f.prisma, f.redis),
        f.services.leaderboards,
        sockets.auth,
      );
      await admin.updateUser({ sub: SUPER_ID, role: 'SUPER_ADMIN' }, ATHLETE_ID, {
        isActive: false,
      });
      await disconnected;
      const blocked = sockets.client('/ws/events', f.token());
      await deadline(
        new Promise<void>((resolve, reject) => {
          blocked.once('connect_error', () => resolve());
          blocked.once('connect', () => reject(new Error('Deactivated account connected')));
          blocked.connect();
        }),
      );
      f.state.tables.user.get(ATHLETE_ID)!.isActive = true;
      f.state.tables.identityVerification.get(ATHLETE_ID)!.status = 'REVOKED';
      const revoked = sockets.client('/ws/matchmaking', f.token());
      await deadline(
        new Promise<void>((resolve, reject) => {
          revoked.once('connect_error', () => resolve());
          revoked.once('connect', () => reject(new Error('Revoked account connected')));
          revoked.connect();
        }),
      );
    } finally {
      await sockets.close();
    }
  });

  it('exposes dashboard KPIs only to administrators and bounds management pagination', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    try {
      const unauth = await app.inject({ method: 'GET', url: '/api/v1/admin/dashboard' });
      assert.strictEqual(unauth.statusCode, 401);
      const denied = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/dashboard',
        headers: { authorization: `Bearer ${f.token()}` },
      });
      assert.strictEqual(denied.statusCode, 403);
      const headers = { authorization: `Bearer ${f.token(SUPER_ID)}` };
      const response = await app.inject({ method: 'GET', url: '/api/v1/admin/dashboard', headers });
      assert.strictEqual(response.statusCode, 200, response.body);
      const body = response.json<{
        verifiedAthletes: number;
        activeTournaments: number;
        organizers: number;
        scouts: number;
        verifiedDrills: number;
        criticalMatchPauses: number;
        health: { db: string; redis: string };
      }>();
      assert.strictEqual(body.verifiedAthletes, 2);
      assert.strictEqual(body.activeTournaments, 1);
      assert.strictEqual(body.organizers, 1);
      assert.strictEqual(body.scouts, 1);
      assert.strictEqual(body.verifiedDrills, 0);
      assert.strictEqual(body.criticalMatchPauses, 0);
      assert.strictEqual(body.health.db, 'ok');
      assert.strictEqual(body.health.redis, 'ok');
      const users = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/users?limit=2',
        headers,
      });
      assert.strictEqual(users.statusCode, 200, users.body);
      const page = users.json<{ data: unknown[]; nextCursor: string }>();
      assert.strictEqual(page.data.length, 2);
      assert.ok(page.nextCursor);
      assert.strictEqual(
        (await app.inject({ method: 'GET', url: '/api/v1/admin/users?limit=101', headers }))
          .statusCode,
        400,
      );
      assert.strictEqual(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/admin/audit-logs',
            headers: { authorization: `Bearer ${f.token(ORGANIZER_ID)}` },
          })
        ).statusCode,
        403,
      );
    } finally {
      await app.close();
    }
  });

  it('audits user status changes, requires bound identity evidence, and prevents federation privilege escalation or last-admin removal', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const headers = {
      authorization: `Bearer ${f.token(SUPER_ID)}`,
      'idempotency-key': randomUUID(),
    };
    try {
      const changed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${ATHLETE_ID}/status`,
        headers,
        payload: { isActive: false, verificationStatus: 'REVOKED' },
      });
      assert.strictEqual(changed.statusCode, 200, changed.body);
      assert.strictEqual(f.user().isActive, false);
      assert.strictEqual(f.user().identityRecord?.status, 'REVOKED');
      assert.strictEqual(f.state.tables.securityAuditLog.size, 1);
      for (const payload of [
        { role: null },
        { verificationStatus: null },
        { isActive: null },
        { isActive: 'false' },
      ]) {
        const invalid = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/users/${OPPONENT_ID}/status`,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload,
        });
        assert.strictEqual(invalid.statusCode, 400, invalid.body);
      }
      const last = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${SUPER_ID}/status`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { isActive: false },
      });
      assert.strictEqual(last.statusCode, 409, last.body);
      f.state.tables.identityVerification.delete(OPPONENT_ID);
      const invented = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${OPPONENT_ID}/status`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { verificationStatus: 'VERIFIED' },
      });
      assert.strictEqual(invented.statusCode, 400, invented.body);
      f.state.tables.user.get(ORGANIZER_ID)!.role = 'FEDERATION_ADMIN';
      const escalated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${OPPONENT_ID}/status`,
        headers: {
          authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
          'idempotency-key': randomUUID(),
        },
        payload: { role: 'SUPER_ADMIN' },
      });
      assert.strictEqual(escalated.statusCode, 403, escalated.body);
      const audit = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs?action=ADMIN_USER_STATUS_CHANGED',
        headers,
      });
      assert.strictEqual(audit.statusCode, 200, audit.body);
      assert.strictEqual(audit.json<{ data: unknown[] }>().data.length, 1);
    } finally {
      await app.close();
    }
  });

  it('supports global tournament moderation and preserves an immutable administrative event for each action', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const id = [...f.state.tables.tournament.keys()][0]!;
    f.state.tables.tournament.get(id)!.status = 'DRAFT';
    try {
      for (const [action, status, featured] of [
        ['APPROVE', 'REGISTRATION_OPEN', false],
        ['FEATURE', 'REGISTRATION_OPEN', true],
        ['SUSPEND', 'SUSPENDED', false],
        ['CLOSE', 'COMPLETED', false],
      ] as const) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/tournaments/${id}/status`,
          headers: {
            authorization: `Bearer ${f.token(SUPER_ID)}`,
            'idempotency-key': randomUUID(),
          },
          payload: { action },
        });
        assert.strictEqual(response.statusCode, 200, response.body);
        assert.strictEqual(f.state.tables.tournament.get(id)!.status, status);
        assert.strictEqual(f.state.tables.tournament.get(id)!.isFeatured, featured);
      }
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/tournaments?status=COMPLETED',
        headers: { authorization: `Bearer ${f.token(SUPER_ID)}` },
      });
      assert.strictEqual(response.statusCode, 200, response.body);
      assert.strictEqual(response.json<{ data: unknown[] }>().data.length, 1);
      assert.strictEqual(f.state.tables.securityAuditLog.size, 4);
    } finally {
      await app.close();
    }
  });
});
