import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExecutionContext } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { Prisma, SportType } from '@prisma/client';
import { validateEnvironment } from '../src/config/validate-environment';
import { DrillsService } from '../src/modules/drills/drills.service';
import { WsAuthGuard, AuthenticatedSocket } from '../src/infrastructure/realtime/ws-auth.guard';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { LeaderboardsService } from '../src/modules/leaderboards/leaderboards.service';
import { LeaderboardScope } from '../src/modules/leaderboards/leaderboards.dto';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { createAuthFixture } from './helpers/auth-passport.fixture';
import {
  ATHLETE_ID,
  OPPONENT_ID,
  ORGANIZER_ID,
  createSecurityFixture,
} from './helpers/security-gti.fixture';
import { BRACKET_ID, TOURNAMENT_ID } from './helpers/competition.fixture';

describe('Phase 2 Tasks 4-6: Supavisor Pooling, SQL Query Optimizations & Indexes', () => {
  it('validates Supavisor :6543 requires pgbouncer=true + DIRECT_URL and schema.prisma declares directUrl', () => {
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const baseProdEnv = {
      NODE_ENV: 'production',
      IDENTITY_PEPPER: randomBytes(32).toString('hex'),
      DRILL_HMAC_SECRET: randomBytes(32).toString('hex'),
      TELEMETRY_SERVICE_HMAC_SECRET: randomBytes(32).toString('hex'),
      JWT_PRIVATE_KEY: Buffer.from(rsa.privateKey, 'utf8').toString('base64'),
      JWT_PUBLIC_KEY: Buffer.from(rsa.publicKey, 'utf8').toString('base64'),
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      CORS_ORIGINS: 'https://app.example.com',
      REDIS_URL: 'rediss://default:pass@localhost:6380/0',
    };

    assert.throws(
      () =>
        validateEnvironment({
          ...baseProdEnv,
          DATABASE_URL: 'postgresql://user:pass@aws-0.pooler.supabase.com:6543/postgres',
        }),
      /pgbouncer=true/,
    );
    assert.throws(
      () =>
        validateEnvironment({
          ...baseProdEnv,
          DATABASE_URL: 'postgresql://user:pass@aws-0.pooler.supabase.com:6543/postgres?pgbouncer=true',
        }),
      /DIRECT_URL is required/,
    );
    assert.doesNotThrow(() =>
      validateEnvironment({
        ...baseProdEnv,
        DATABASE_URL: 'postgresql://user:pass@aws-0.pooler.supabase.com:6543/postgres?pgbouncer=true',
        DIRECT_URL: 'postgresql://user:pass@db.supabase.co:5432/postgres?sslmode=require',
      }),
    );

    const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
    assert.match(schema, /directUrl\s*=\s*env\("DIRECT_URL"\)/);
  });

  it('removes mode:insensitive on drill signatureHash lookup and skips redundant Passport queries', async () => {
    const f = await createSecurityFixture();
    let capturedWhere: unknown;
    const drillRepo = f.prisma.drillSubmission as unknown as {
      findFirst: (args: Prisma.DrillSubmissionFindFirstArgs) => Promise<unknown>;
    };
    const origFindFirst = drillRepo.findFirst;
    drillRepo.findFirst = async (args: Prisma.DrillSubmissionFindFirstArgs) => {
      capturedWhere = args.where;
      return origFindFirst(args);
    };

    const drills = new DrillsService(f.prisma, f.queue);
    await drills.submitDrill(
      ATHLETE_ID,
      {
        sport: SportType.CRICKET,
        drill_type: 'CRICKET_BOWLING',
        form_score: 84,
        frames_analyzed: 100,
        flaw_flags: [],
        joint_angles_summary: {},
        timestamp: Date.now(),
      },
      'ABCDEF'.padEnd(64, '0'),
    );
    const orBranches = (capturedWhere as { OR: Array<Record<string, unknown>> }).OR;
    assert.strictEqual(typeof orBranches[0]?.signatureHash, 'string');
    assert.strictEqual(orBranches[0]?.signatureHash, 'abcdef'.padEnd(64, '0'));

    const auth = createAuthFixture();
    let identityLookups = 0;
    const authPrisma = auth.database as unknown as {
      identityVerification: { findUnique: () => Promise<unknown> };
    };
    const origIdentityFind = authPrisma.identityVerification.findUnique;
    authPrisma.identityVerification.findUnique = async () => {
      identityLookups++;
      return origIdentityFind();
    };
    await auth.passports.upsertPassport(auth.state.user.id, {
      dateOfBirth: '2006-05-01',
      gender: 'MALE',
      primarySport: SportType.CRICKET,
      district: 'Pune',
      state: 'Maharashtra',
    });
    identityLookups = 0;
    await auth.passports.getPassportByUserId(auth.state.user.id);
    assert.strictEqual(identityLookups, 0, 'Joined user.identityRecord skips second query');

    let profileReads = 0;
    const profileRepo = auth.database.athleteProfile as unknown as {
      findUnique: (args: Prisma.AthleteProfileFindUniqueArgs) => Promise<unknown>;
    };
    const origProfileFind = profileRepo.findUnique;
    profileRepo.findUnique = async (args: Prisma.AthleteProfileFindUniqueArgs) => {
      profileReads++;
      return origProfileFind(args);
    };
    await auth.passports.listSportRecords(auth.state.user.id, { limit: 20 });
    assert.strictEqual(profileReads, 1, 'listSportRecords must only query athleteProfile once');
  });

  it('combines dossier wearableSession count and aggregate into one query and skips double WsAuth DB lookup', async () => {
    const auth = createAuthFixture();
    await auth.passports.upsertPassport(auth.state.user.id, {
      dateOfBirth: '2006-05-01',
      gender: 'MALE',
      primarySport: SportType.CRICKET,
      district: 'Pune',
      state: 'Maharashtra',
    });
    let wearableCountCalls = 0;
    let wearableAggregateCalls = 0;
    const authPrisma = auth.database as unknown as {
      wearableSession: {
        count: () => Promise<number>;
        aggregate: (args: unknown) => Promise<unknown>;
      };
    };
    authPrisma.wearableSession.count = async () => {
      wearableCountCalls++;
      return 0;
    };
    authPrisma.wearableSession.aggregate = async () => {
      wearableAggregateCalls++;
      return {
        _count: { _all: 3 },
        _sum: {
          readingsCount: 15,
          heartRateSum: 1800,
          spo2Sum: 1470,
          simulatorReadings: 0,
          baselineSpo2Readings: 0,
        },
      };
    };
    const result = await auth.dossiers.getDossier(auth.state.user.id, {
      sub: auth.state.user.id,
      role: 'ATHLETE',
    });
    assert.strictEqual(wearableAggregateCalls, 1);
    assert.strictEqual(wearableCountCalls, 0);
    assert.strictEqual(result.wearable_summary.sessions_monitored, 3);

    let authCalls = 0;
    const fakeStrategy = {
      authenticateToken: async () => {
        authCalls++;
        return {
          sub: ATHLETE_ID,
          role: 'ATHLETE',
          exp: Math.floor(Date.now() / 1000) + 600,
          identityVerified: true,
        };
      },
    } as unknown as JwtStrategy;
    const guard = new WsAuthGuard(fakeStrategy);
    const socket = {
      handshake: { auth: { token: 'jwt' }, query: {}, headers: {} },
      data: {},
      join: async () => {},
      once: () => {},
      disconnect: () => {},
    } as unknown as AuthenticatedSocket;

    await guard.authenticate(socket);
    await guard.accept(socket);
    await guard.canActivate({
      switchToWs: () => ({ getClient: () => socket }),
    } as unknown as ExecutionContext);
    assert.strictEqual(authCalls, 1, 'WsAuthGuard must authenticate once across handshake + messages');
  });

  it('batches MatchResultsService participant queries and removes Leaderboards COUNT(*) before Redis', async () => {
    const f = await createSecurityFixture();
    let findManyCalls = 0;
    const origFindMany = f.prisma.athleteProfile.findMany;
    f.prisma.athleteProfile.findMany = (async (args: Prisma.AthleteProfileFindManyArgs) => {
      findManyCalls++;
      return origFindMany(args);
    }) as typeof f.prisma.athleteProfile.findMany;

    await f.services.results.recordResult(
      TOURNAMENT_ID,
      BRACKET_ID,
      { sub: ORGANIZER_ID, role: 'ORGANIZER' },
      {
        participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
        winnerAthleteIds: [ATHLETE_ID],
      },
      'batch-result-key-0001',
    );
    assert.strictEqual(findManyCalls, 1, 'Expected 1 batched athleteProfile.findMany for all participants');

    // Verify Redis leaderboard hit does NOT trigger athleteProfile.count
    f.setProfile({ gti: 90, currentGti: new Prisma.Decimal(90), primarySport: SportType.CRICKET });
    await f.services.leaderboards.syncAthlete(ATHLETE_ID);
    let countCalls = 0;
    f.prisma.athleteProfile.count = (async () => {
      countCalls++;
      return 999;
    }) as typeof f.prisma.athleteProfile.count;
    const page = await f.services.leaderboards.list({
      sport: SportType.CRICKET,
      scope: LeaderboardScope.NATIONAL,
      limit: 10,
    });
    assert.strictEqual(page.source, 'redis');
    assert.strictEqual(countCalls, 0, 'Redis hit must not query PostgreSQL COUNT(*)');
  });

  describe('Migrated PostgreSQL EXPLAIN ANALYZE index & query plan verification', () => {
    const db = new PGlite({ extensions: { postgis } });

    before(async () => {
      const root = resolve(__dirname, '../prisma/migrations');
      for (const dir of readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        await db.exec(readFileSync(resolve(root, dir.name, 'migration.sql'), 'utf8'));
      }

      // Seed 350 athletes + drills + outbox rows so planner evaluates real index plans
      const baseDate = new Date();
      for (let i = 0; i < 350; i++) {
        const uid = randomUUID();
        const pid = randomUUID();
        await db.query('INSERT INTO users(id, role, is_active, updated_at) VALUES($1, \'ATHLETE\', true, now())', [
          uid,
        ]);
        await db.query(
          `INSERT INTO identity_verifications(id, user_id, id_hash, id_type, status) VALUES($1, $2, $3, 'AADHAAR', 'VERIFIED')`,
          [randomUUID(), uid, uid.replaceAll('-', '').padEnd(64, 'a')],
        );
        await db.query(
          `INSERT INTO athlete_profiles(id, user_id, primary_sport, state, district, is_scout_searchable, gti, current_gti, updated_at)
           VALUES($1, $2, 'CRICKET', 'Maharashtra', 'Pune', true, $3::float8, $3::numeric, now())`,
          [pid, uid, (i % 100) + 1],
        );
        await db.query(
          `INSERT INTO drill_submissions(id, athlete_id, sport, drill_type, form_score, frames_analyzed, flaw_flags, joint_angles_summary, signature_hash, metadata_verified, created_at)
           VALUES($1, $2, 'CRICKET', 'BOWLING', 85, 120, '[]', '{}', $3, true, $4)`,
          [randomUUID(), uid, uid.replaceAll('-', '').padEnd(64, 'b'), baseDate],
        );
      }
      await db.exec('UPDATE outbox_events SET delivered_at = now()');
      await db.exec('ANALYZE');
    });

    after(async () => {
      await db.close();
    });

    it('drops redundant id_hash index, creates new partial/FK indexes, and uses indexes in EXPLAIN ANALYZE', async () => {
      const redundant = await db.query(
        "SELECT indexname FROM pg_indexes WHERE tablename='identity_verifications' AND indexname='identity_verifications_id_hash_idx'",
      );
      assert.strictEqual(redundant.rows.length, 0);

      const newIndexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE indexname IN (
          'athlete_profiles_leaderboard_active_idx',
          'athlete_profiles_geo_leaderboard_idx',
          'athlete_profiles_scout_searchable_gti_id_idx',
          'drill_submissions_dossier_verified_idx',
          'free_agent_pool_fifo_idx',
          'tournaments_organizer_id_idx',
          'registrations_team_id_idx',
          'team_members_team_id_idx',
          'matches_umpire_id_idx',
          'matches_team_b_id_idx',
          'health_alerts_tournament_id_created_at_idx',
          'health_alerts_match_id_idx',
          'refresh_tokens_active_expires_at_idx'
        )`,
      );
      assert.strictEqual(newIndexes.rows.length, 13);

      // 1. Exact drill signature lookup -> Index Only / Index Scan on drill_submissions_signature_hash_key
      const probeSig = 'a'.repeat(64);
      const drillPlan = (
        await db.query<{ 'QUERY PLAN': string }>(
          'EXPLAIN ANALYZE SELECT id FROM drill_submissions WHERE signature_hash = $1 LIMIT 1',
          [probeSig],
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      assert.match(drillPlan, /Index (Only )?Scan using drill_submissions_signature_hash_key/);

      // 2. Pending outbox poll -> uses outbox_events_pending_dispatch_idx partial index cleanly over 700 delivered rows
      const outboxPlan = (
        await db.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN ANALYZE SELECT id FROM outbox_events
           WHERE delivered_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now())
           ORDER BY created_at, id LIMIT 25`,
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      assert.match(outboxPlan, /Index (Only )?Scan.*outbox_events_pending_dispatch_idx/);

      // 3. Leaderboard single-CTE query execution against PGlite with COUNT(*) OVER() and lower(state)/lower(district)
      const lbPrisma = {
        athleteProfile: { count: async () => 999 },
        $queryRaw: async (q: Prisma.Sql) => (await db.query(q.text, q.values)).rows,
      } as unknown as PrismaService;
      const offlineRedis = {
        client: { zcard: async () => 0 },
      } as unknown as RedisService;
      const leaderboardSvc = new LeaderboardsService(lbPrisma, offlineRedis);
      const res = await leaderboardSvc.list({
        sport: SportType.CRICKET,
        scope: LeaderboardScope.DISTRICT,
        state: 'Maharashtra',
        district: 'Pune',
        limit: 10,
      });
      assert.strictEqual(res.source, 'database');
      assert.strictEqual(res.data.length, 10);
      assert.strictEqual(res.total, 350);
    });
  });
});
