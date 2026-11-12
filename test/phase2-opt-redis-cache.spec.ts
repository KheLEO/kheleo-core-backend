import 'reflect-metadata';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, SportType, TournamentStatus, UserRole, VerificationStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { HeatmapsService } from '../src/modules/heatmaps/heatmaps.service';
import { PassportService } from '../src/modules/passport/passport.service';
import { TournamentsService } from '../src/modules/tournaments/tournaments.service';
import { OrganizerService } from '../src/modules/tournaments/organizer.service';
import { PostgisSpatialRepository } from '../src/infrastructure/database/postgis-spatial.repository';
import { MatchmakingService } from '../src/modules/matchmaking/matchmaking.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { CACHE_KEYS } from '../src/infrastructure/cache/cache-helper';
import { LeaderboardScope } from '../src/modules/leaderboards/leaderboards.dto';
import { AdminService } from '../src/modules/admin/admin.service';
import { BracketsService } from '../src/modules/brackets/brackets.service';
import { HealthService } from '../src/modules/health/health.service';
import { WsAuthGuard } from '../src/infrastructure/realtime/ws-auth.guard';
import { createAuthFixture, TEST_SECRET, TEST_USER_ID } from './helpers/auth-passport.fixture';
import { ATHLETE_ID, createSecurityFixture } from './helpers/security-gti.fixture';
import {
  BRACKET_ID,
  createCompetitionFixture,
  TOURNAMENT_ID,
} from './helpers/competition.fixture';

function createCacheEnabledRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  let failMode: 'none' | 'throw' | 'hang' = 'none';

  const guard = async <T>(op: () => T): Promise<T> => {
    if (failMode === 'throw') throw new Error('Redis connection refused');
    if (failMode === 'hang') {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return op();
  };

  const redis = {
    isCacheEnabled: true,
    store,
    ttls,
    setMode(mode: 'none' | 'throw' | 'hang') {
      failMode = mode;
    },
    get: async (key: string) => guard(() => store.get(key) ?? null),
    set: async (key: string, value: string, ttlSeconds?: number) =>
      guard(() => {
        store.set(key, value);
        if (ttlSeconds !== undefined) ttls.set(key, ttlSeconds);
      }),
    del: async (key: string) =>
      guard(() => {
        store.delete(key);
      }),
    incr: async (key: string) =>
      guard(() => {
        const next = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(next));
        return next;
      }),
  };

  return redis;
}

describe('Phase 2 Task 7: Multi-Layer Redis Caching, Invalidation & Outage Fallback', () => {
  it('caches JwtStrategy auth user lookup in Redis (120s) and invalidates on admin moderation', async () => {
    const auth = createAuthFixture();
    const redis = createCacheEnabledRedis();
    let userReads = 0;
    const origFind = auth.database.user.findUnique;
    (auth.database.user as unknown as { findUnique: (a: unknown) => Promise<unknown> }).findUnique =
      async (args: unknown) => {
        userReads++;
        return origFind(args as Prisma.UserFindUniqueArgs);
      };

    const strategy = new JwtStrategy(
      auth.config,
      auth.database,
      redis as unknown as RedisService,
    );
    const payload = {
      sub: auth.state.user.id,
      role: 'ATHLETE',
      exp: Math.floor(Date.now() / 1000) + 600,
    };

    const first = await strategy.validate(payload);
    assert.strictEqual(first.sub, auth.state.user.id);
    assert.strictEqual(userReads, 1);
    assert.strictEqual(redis.ttls.get(CACHE_KEYS.authUser(auth.state.user.id)), 120);

    // Second validation hits Redis (0 DB calls)
    await strategy.validate(payload);
    assert.strictEqual(userReads, 1);

    // Simulate admin revocation invalidating auth cache
    const admin = new AdminService(
      auth.database,
      {} as HealthService,
      { syncAthlete: async () => {} } as never,
      { disconnectUser: () => {} } as unknown as WsAuthGuard,
      redis as unknown as RedisService,
    );
    const origTransaction = auth.database.$transaction;
    (auth.database as unknown as Record<string, unknown>).$transaction = origTransaction;
    (auth.database as unknown as { securityAuditLog: { create: () => Promise<unknown> } }).securityAuditLog = {
      create: async () => ({}),
    };
    const origUpdate = auth.database.user.update;
    auth.state.user.identityRecord = {
      id: randomUUID(),
      userId: auth.state.user.id,
      idHash: 'a'.repeat(64),
      idType: 'AADHAAR',
      saltVersion: 1,
      status: VerificationStatus.VERIFIED,
      reLinkedCount: 0,
      historicalUserIds: [],
      verifiedAt: new Date(),
      metadata: null,
    };
    (auth.database.user as unknown as { update: (a: unknown) => Promise<unknown> }).update = async (
      args: unknown,
    ) => {
      const updated = await origUpdate(args as Prisma.UserUpdateArgs);
      return { ...updated, identityRecord: auth.state.user.identityRecord };
    };

    await admin.updateUser(
      { sub: randomUUID(), role: UserRole.SUPER_ADMIN },
      auth.state.user.id,
      { isActive: false },
    );
    assert.strictEqual(redis.store.has(CACHE_KEYS.authUser(auth.state.user.id)), false);

    // Next JWT validation fetches fresh deactivated state and rejects
    await assert.rejects(strategy.validate(payload));
    assert.strictEqual(userReads, 3); // 1 updateUserStatus lookup + 1 JwtStrategy refresh lookup

    // Verify Redis outage fallback cleanly queries DB
    auth.state.user.isActive = true;
    redis.setMode('throw');
    const recovered = await strategy.validate(payload);
    assert.strictEqual(recovered.sub, auth.state.user.id);
    assert.strictEqual(userReads, 4);
  });

  it('prevents regional heatmap cache stampedes with single-flight loading and degrades gracefully on Redis timeout', async () => {
    const redis = createCacheEnabledRedis();
    let dbQueries = 0;
    const prisma = {
      $queryRaw: async () => {
        dbQueries++;
        await new Promise((r) => setTimeout(r, 20));
        return [
          {
            state: 'Maharashtra',
            district: 'Pune',
            total_athletes: 120,
            average_gti: 74.5,
            female_participation_pct: 41.2,
            centroid: JSON.stringify({ type: 'Point', coordinates: [73.8567, 18.5204] }),
          },
        ];
      },
    } as unknown as PrismaService;

    const service = new HeatmapsService(prisma, redis as unknown as RedisService);
    // 15 concurrent requests hit cold cache -> 1 single DB query
    const batch = await Promise.all(Array.from({ length: 15 }, () => service.getRegionalHeatmap()));
    assert.strictEqual(dbQueries, 1);
    assert.strictEqual(batch[0]!.count, 1);
    assert.strictEqual(redis.ttls.get(CACHE_KEYS.regionalHeatmap()), 300);

    // Warm read -> still 1 DB query
    await service.getRegionalHeatmap();
    assert.strictEqual(dbQueries, 1);

    // Redis outage -> gracefully loads from PostgreSQL
    redis.setMode('throw');
    const fallback = await service.getRegionalHeatmap();
    assert.strictEqual(fallback.data[0]?.district, 'Pune');
    assert.strictEqual(dbQueries, 2);
  });

  it('caches athlete passports while enforcing scout authorization and invalidates on updates', async () => {
    const auth = createAuthFixture();
    const redis = createCacheEnabledRedis();
    const passports = new PassportService(
      auth.database,
      undefined,
      auth.config as unknown as ConfigService,
      redis as unknown as RedisService,
    );
    await passports.upsertPassport(auth.state.user.id, {
      dateOfBirth: '2006-05-01',
      gender: 'MALE',
      primarySport: SportType.CRICKET,
      district: 'Pune',
      state: 'Maharashtra',
      isScoutSearchable: false,
    });

    let profileReads = 0;
    const repo = auth.database.athleteProfile as unknown as {
      findUnique: (a: Prisma.AthleteProfileFindUniqueArgs) => Promise<unknown>;
    };
    const origFind = repo.findUnique;
    repo.findUnique = async (args) => {
      profileReads++;
      return origFind(args);
    };

    const first = await passports.getPassportByUserId(auth.state.user.id);
    assert.strictEqual(first.district, 'Pune');
    assert.strictEqual(profileReads, 1);

    // Warm read hits Redis (0 DB calls), and still rejects unauthorized SCOUT viewer
    await passports.getPassportByUserId(auth.state.user.id);
    assert.strictEqual(profileReads, 1);
    await assert.rejects(
      passports.getPassportByUserId(auth.state.user.id, {
        sub: randomUUID(),
        role: 'SCOUT',
      }),
      /opted into scout discovery/,
    );
    assert.strictEqual(profileReads, 1);

    // Writing invalidates passport:v1:{userId}
    await passports.upsertPassport(auth.state.user.id, {
      district: 'Mumbai',
      state: 'Maharashtra',
    });
    assert.strictEqual(redis.store.has(CACHE_KEYS.passport(auth.state.user.id)), false);
  });

  it('serves leaderboard pages from Redis page cache and rotates version atomically on syncAthlete', async () => {
    const f = await createSecurityFixture();
    const redis = Object.assign(createCacheEnabledRedis(), {
      client: f.redisClient,
    }) as unknown as RedisService & ReturnType<typeof createCacheEnabledRedis>;
    const leaderboards = new (f.services.leaderboards.constructor as new (
      p: PrismaService,
      r: RedisService,
    ) => typeof f.services.leaderboards)(f.prisma, redis);

    f.setProfile({ gti: 92, currentGti: new Prisma.Decimal(92), primarySport: SportType.CRICKET });
    await leaderboards.syncAthlete(ATHLETE_ID);

    let findManyCalls = 0;
    const origFindMany = f.prisma.athleteProfile.findMany;
    (f.prisma.athleteProfile as unknown as { findMany: (a: unknown) => Promise<unknown> }).findMany =
      async (args) => {
        findManyCalls++;
        return origFindMany(args as Prisma.AthleteProfileFindManyArgs);
      };

    const q = {
      sport: SportType.CRICKET,
      scope: LeaderboardScope.NATIONAL,
      limit: 10,
    };
    const p1 = await leaderboards.list(q);
    assert.strictEqual(p1.source, 'redis');
    assert.strictEqual(findManyCalls, 1);

    // Second read served fully from Redis page cache (0 Prisma findMany calls)
    const p2 = await leaderboards.list(q);
    assert.strictEqual(p2.source, 'redis');
    assert.strictEqual(findManyCalls, 1);

    // syncAthlete rotates leaderboard:v1:ver so next read reflects new score immediately
    f.setProfile({ gti: 95, currentGti: new Prisma.Decimal(95) });
    await leaderboards.syncAthlete(ATHLETE_ID);
    const p3 = await leaderboards.list(q);
    assert.strictEqual(p3.data[0]?.gti, 95);
    assert.strictEqual(findManyCalls, 2);
  });

  it('caches nearby tournaments and organizer summaries cleanly and rotates versions on tournament creation', async () => {
    const redis = createCacheEnabledRedis();
    let nearbyCalls = 0;
    const spatialRepo = {
      findTournamentsWithinRadius: async () => {
        nearbyCalls++;
        return {
          data: [
            {
              id: randomUUID(),
              name: 'District Open',
              title: 'District Open',
              sport: SportType.CRICKET,
              status: TournamentStatus.REGISTRATION_OPEN,
              min_gti: 0,
              max_gti: 100,
              venue_name: 'Pune Ground',
              venue_lat: 18.52,
              venue_lng: 73.85,
              distance_km: 1.2,
              start_date: new Date(),
              registration_deadline: new Date(),
              prize_pool: 5000,
              max_teams: 16,
              team_size: 11,
            },
          ],
          next_cursor: null,
          has_more: false,
        };
      },
    } as unknown as PostgisSpatialRepository;

    let tournamentCountCalls = 0;
    const prisma = {
      tournament: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: randomUUID(),
          ...data,
        }),
        count: async () => {
          tournamentCountCalls++;
          return 2;
        },
        aggregate: async () => ({ _sum: { prizePool: new Prisma.Decimal(10000) } }),
      },
      user: { count: async () => 12 },
      team: { count: async () => 3 },
      healthAlert: { count: async () => 0 },
    } as unknown as PrismaService;

    const tournaments = new TournamentsService(
      prisma,
      spatialRepo,
      redis as unknown as RedisService,
    );
    const nearbyQuery = {
      lat: 18.5204,
      lng: 73.8567,
      sport: SportType.CRICKET,
      radius_km: 50,
      limit: 20,
    };
    await tournaments.findNearby(nearbyQuery);
    await tournaments.findNearby(nearbyQuery);
    assert.strictEqual(nearbyCalls, 1);

    const organizerId = randomUUID();
    const organizer = new OrganizerService(
      prisma,
      {} as MatchmakingService,
      redis as unknown as RedisService,
    );
    await organizer.summary({ sub: organizerId, role: UserRole.ORGANIZER });
    await organizer.summary({ sub: organizerId, role: UserRole.ORGANIZER });
    assert.strictEqual(tournamentCountCalls, 1);

    await tournaments.create(organizerId, {
      name: 'New Cup',
      sport: SportType.CRICKET,
      venueName: 'Shivaji Stadium',
      venueLat: 18.52,
      venueLng: 73.85,
      maxTeams: 8,
      teamSize: 11,
      registrationDeadline: new Date(Date.now() + 86400000).toISOString(),
      startDate: new Date(Date.now() + 2 * 86400000).toISOString(),
      endDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    });
    await tournaments.findNearby(nearbyQuery);
    await organizer.summary({ sub: organizerId, role: UserRole.ORGANIZER });
    assert.strictEqual(nearbyCalls, 2);
    assert.strictEqual(tournamentCountCalls, 2);

    // Registration and tournament moderation also rotate organizer/tournament versions
    const comp = createCompetitionFixture();
    const orgId = comp.state.tournaments.get(TOURNAMENT_ID)!.organizerId;
    const orgVerBeforeReg = redis.store.get(CACHE_KEYS.organizerVersion(orgId)) ?? '0';
    const bracketsWithRedis = new BracketsService(
      comp.prisma as unknown as PrismaService,
      redis as unknown as RedisService,
    );
    await bracketsWithRedis.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {});
    const orgVerAfterReg = redis.store.get(CACHE_KEYS.organizerVersion(orgId)) ?? '0';
    assert.notStrictEqual(orgVerAfterReg, orgVerBeforeReg);

    const adminMod = new AdminService(
      {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            tournament: {
              findUnique: async () => ({
                id: TOURNAMENT_ID,
                organizerId: orgId,
                status: TournamentStatus.REGISTRATION_OPEN,
                registrationDeadline: new Date(Date.now() + 86400000),
                isFeatured: false,
              }),
              update: async () => ({
                id: TOURNAMENT_ID,
                organizerId: orgId,
                status: TournamentStatus.SUSPENDED,
                isFeatured: false,
              }),
            },
            securityAuditLog: { create: async () => ({}) },
          }),
      } as unknown as PrismaService,
      {} as HealthService,
      { syncAthlete: async () => {} } as never,
      { disconnectUser: () => {} } as unknown as WsAuthGuard,
      redis as unknown as RedisService,
    );
    const tourVerBeforeMod = redis.store.get(CACHE_KEYS.tournamentsVersion()) ?? '0';
    await adminMod.moderateTournament({ sub: randomUUID(), role: UserRole.SUPER_ADMIN }, TOURNAMENT_ID, {
      suspended: true,
    });
    assert.notStrictEqual(redis.store.get(CACHE_KEYS.tournamentsVersion()) ?? '0', tourVerBeforeMod);
    assert.notStrictEqual(redis.store.get(CACHE_KEYS.organizerVersion(orgId)) ?? '0', orgVerAfterReg);

    assert.ok(TEST_SECRET);
  });
});
