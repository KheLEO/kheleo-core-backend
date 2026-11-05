import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
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
