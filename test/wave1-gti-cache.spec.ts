import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Global, Module, ModuleMetadata, Type } from '@nestjs/common';
import { GLOBAL_MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { Prisma, SportType } from '@prisma/client';
import { createAppModuleMetadata } from '../src/app.module';
import { ConfigurationModule } from '../src/config/configuration.module';
import { RedisModule } from '../src/infrastructure/cache/redis.module';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import {
  CACHE_KEYS,
  invalidateCacheKeys,
  readThroughCache,
} from '../src/infrastructure/cache/cache-helper';
import { PrismaModule } from '../src/infrastructure/database/prisma.module';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { PostgisSpatialRepository } from '../src/infrastructure/database/postgis-spatial.repository';
import { BullmqModule } from '../src/infrastructure/queues/bullmq.module';
import { QueueProducerService } from '../src/infrastructure/queues/queue-producer.service';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { WsEventGateway } from '../src/infrastructure/realtime/ws-event.gateway';
import { DrillsService } from '../src/modules/drills/drills.service';
import { GtiService } from '../src/modules/gti/gti.service';
import { GtiCalculationProcessor } from '../src/modules/gti/processors/gti-calculation.processor';
import { ScoutAlertsProcessor } from '../src/modules/gti/processors/scout-alerts.processor';
import { LeaderboardsService } from '../src/modules/leaderboards/leaderboards.service';
import { LeaderboardScope } from '../src/modules/leaderboards/leaderboards.dto';
import { MatchmakingProcessor } from '../src/modules/matchmaking/processors/matchmaking.processor';
import { PassportService } from '../src/modules/passport/passport.service';
import { readParticipationSnapshot } from '../src/modules/tournaments/participation-policy';
import { ScoutsService } from '../src/modules/scouts/scouts.service';
import { BracketsService } from '../src/modules/brackets/brackets.service';
import { SafetyService } from '../src/modules/safety/safety.service';
import { createWave1SqlFixture } from './helpers/wave1-sql.fixture';
import { ATHLETE_ID, createSecurityFixture } from './helpers/security-gti.fixture';
import { BRACKET_ID, TOURNAMENT_ID } from './helpers/competition.fixture';
import {
  prismaReconciliationDb,
  reconcileGtiRecords,
  ReconcileSqlDb,
} from '../scripts/reconcile-gti-scores';
import { fixBaselinesWithPrisma } from '../scripts/fix-existing-developer-baselines';

function memoryRedis() {
  const values = new Map<string, string>();
  return {
    isCacheEnabled: true,
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    del: async (key: string) => {
      values.delete(key);
    },
    incr: async (key: string) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(next));
      return next;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Wave 1: actual services against migrated memory-only PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof createWave1SqlFixture>>;
  const queue = {
    enqueueWatchExpiry: async () => {},
    enqueueGtiRecalculation: async () => 'local-job',
    enqueueScoutAlert: async () => 'local-scout',
  } as unknown as QueueProducerService;
  const ws = { broadcastGtiUpdated: () => {} } as unknown as WsEventGateway;
  const synced: string[] = [];
  const leaderboards = {
    syncAthlete: async (id: string) => {
      synced.push(id);
    },
  } as unknown as LeaderboardsService;
  before(async () => {
    f = await createWave1SqlFixture();
  });
  after(async () => {
    await f.db.close();
  });

  it('uses the real seven-column SQL defaults and records the onboarding override explicitly', async () => {
    const { userId, profileId } = await f.seedAthlete();
    const row = (
      await f.db.query(
        'SELECT current_gti,gti,biomechanical_score,training_consistency_score,wearable_score,match_performance_score,match_perf_score FROM athlete_profiles WHERE id=$1',
        [profileId],
      )
    ).rows[0]!;
    assert.deepEqual(Object.values(row).map(Number), [30, 0, 0, 0, 50, 0, 50]);
    const result = await new GtiService(f.prisma, leaderboards, queue, ws).recalculateAthleteGti(
      userId,
    );
    assert.equal(result.gti, 30);
    assert.equal(result.calculationMode, 'ONBOARDING_BASELINE');
    assert.deepEqual(result.weights, { w1: 0, w2: 0, w3: 0 });
    const factors = (
      await f.db.query<{ calculation_factors: Record<string, unknown> }>(
        'SELECT calculation_factors FROM gti_histories WHERE athlete_id=$1',
        [profileId],
      )
    ).rows[0]!.calculation_factors;
    assert.equal(factors.baselineGti, 30);
    assert.equal(factors.calculationMode, result.calculationMode);
  });

  it('caps a first drill at 35 without hardware and normalizes drill plus wearable without matches', async () => {
    const { userId, profileId } = await f.seedAthlete();
    await new DrillsService(f.prisma, queue).submitDrill(
      userId,
      {
        sport: SportType.CRICKET,
        drill_type: 'BOWLING',
        form_score: 80,
        frames_analyzed: 120,
        flaw_flags: [],
        joint_angles_summary: {},
        timestamp: Date.now(),
      },
      randomUUID().replaceAll('-', '').padEnd(64, 'a'),
    );
    const gti = new GtiService(f.prisma, leaderboards, queue, ws);
    const drill = await gti.recalculateAthleteGti(userId);
    assert.equal(drill.gti, 35);
    assert.deepEqual(drill.weights, { w1: 1, w2: 0, w3: 0 });
    assert.equal(drill.provisional, false);
    await f.db.query(
      "INSERT INTO wearable_sessions(id,athlete_id,session_date,source) VALUES($1,$2,current_date,'DEVICE_HMAC')",
      [randomUUID(), userId],
    );
    await f.db.query(
      'UPDATE athlete_profiles SET training_consistency_score=5,wearable_score=5 WHERE id=$1',
      [profileId],
    );
    const both = await gti.recalculateAthleteGti(userId);
    assert.equal(both.gti, 22.5);
    assert.deepEqual(both.weights, { w1: 0.5833, w2: 0.4167, w3: 0 });
    const history = (
      await f.db.query<{ calculation_factors: Record<string, unknown>; composite_gti: string }>(
        'SELECT calculation_factors,composite_gti FROM gti_histories WHERE athlete_id=$1 ORDER BY calculated_at DESC,id DESC LIMIT 1',
        [profileId],
      )
    ).rows[0]!;
    assert.equal(Number(history.composite_gti), both.gti);
    assert.equal(history.calculation_factors.w3, 0);
  });

  it('scores a first wearable day at 5 with no match contribution', async () => {
    const { userId, profileId } = await f.seedAthlete();
    await f.db.query(
      "INSERT INTO wearable_sessions(id,athlete_id,session_date,source) VALUES($1,$2,current_date,'DEVICE_HMAC')",
      [randomUUID(), userId],
    );
    await f.db.query(
      'UPDATE athlete_profiles SET training_consistency_score=5,wearable_score=5 WHERE id=$1',
      [profileId],
    );
    const result = await new GtiService(f.prisma, leaderboards, queue, ws).recalculateAthleteGti(
      userId,
    );
    assert.equal(result.gti, 5);
    assert.deepEqual(result.weights, { w1: 0, w2: 1, w3: 0 });
  });

  it('heals exact wiped onboarding on a cold or already-cached Passport read', async () => {
    for (const cached of [false, true]) {
      const { userId, profileId } = await f.seedAthlete();
      const redis = memoryRedis();
      const passport = new PassportService(
        f.prisma,
        leaderboards,
        undefined,
        redis as unknown as RedisService,
      );
      const initial = await passport.getPassportByUserId(userId);
      await f.db.query('UPDATE athlete_profiles SET current_gti=0,gti=0 WHERE id=$1', [profileId]);
      if (cached)
        redis.values.set(
          CACHE_KEYS.passport(userId),
          JSON.stringify({ ...initial, currentGti: 0 }),
        );
      else redis.values.clear();
      assert.equal((await passport.getPassportByUserId(userId)).currentGti, 30);
      const row = (
        await f.db.query<{ current_gti: string; gti: number }>(
          'SELECT current_gti,gti FROM athlete_profiles WHERE id=$1',
          [profileId],
        )
      ).rows[0]!;
      assert.equal(Number(row.current_gti), 30);
      assert.equal(row.gti, 30);
      assert.ok(synced.includes(userId));
    }
  });

  it('preserves a genuine primary-sport zero loss in GTI and Passport, excluding secondary-sport matches', async () => {
    const { userId, profileId } = await f.seedAthlete();
    await f.db.query(
      "INSERT INTO sport_passport_records(id,athlete_id,sport,primary_role,total_matches,updated_at) VALUES($1,$2,'CRICKET','GENERAL_ATHLETE',1,now())",
      [randomUUID(), profileId],
    );
    await f.db.query(
      'UPDATE athlete_profiles SET current_gti=0,gti=0,match_perf_score=0 WHERE id=$1',
      [profileId],
    );
    const gti = new GtiService(f.prisma, leaderboards, queue, ws);
    const loss = await gti.recalculateAthleteGti(userId);
    assert.equal(loss.gti, 0);
    assert.deepEqual(loss.weights, { w1: 0, w2: 0, w3: 1 });
    assert.equal(loss.evidence.matchPerformance, 'VERIFIED');
    assert.equal((await new PassportService(f.prisma).getPassportByUserId(userId)).currentGti, 0);

    const secondary = await f.seedAthlete();
    await f.db.query(
      "INSERT INTO sport_passport_records(id,athlete_id,sport,primary_role,total_matches,updated_at) VALUES($1,$2,'FOOTBALL','GENERAL_ATHLETE',1,now())",
      [randomUUID(), secondary.profileId],
    );
    const untouched = await gti.recalculateAthleteGti(secondary.userId);
    assert.equal(untouched.evidence.matchPerformance, 'NOT_AVAILABLE');
    assert.equal(untouched.gti, 30);
    await f.db.query('UPDATE athlete_profiles SET primary_sport=NULL WHERE id=$1', [
      secondary.profileId,
    ]);
    const noPrimary = await gti.recalculateAthleteGti(secondary.userId);
    assert.equal(noPrimary.evidence.matchPerformance, 'VERIFIED');
    assert.equal(noPrimary.gti, 0);
  });

  it('preserves measured zero drills but restores onboarding when only a safety alert exists', async () => {
    const drilled = await f.seedAthlete();
    await new DrillsService(f.prisma, queue).submitDrill(
      drilled.userId,
      {
        sport: SportType.CRICKET,
        drill_type: 'BOWLING',
        form_score: 0,
        frames_analyzed: 100,
        flaw_flags: [],
        joint_angles_summary: {},
        timestamp: Date.now(),
      },
      randomUUID().replaceAll('-', '').padEnd(64, 'b'),
    );
    await f.db.query('UPDATE athlete_profiles SET gti=0,current_gti=0 WHERE id=$1', [
      drilled.profileId,
    ]);
    assert.equal(
      (await new PassportService(f.prisma).getPassportByUserId(drilled.userId)).currentGti,
      0,
    );
    const alerted = await f.seedAthlete();
    await f.db.query('UPDATE athlete_profiles SET gti=0,current_gti=0 WHERE id=$1', [
      alerted.profileId,
    ]);
    await f.db.query(
      "INSERT INTO health_alerts(id,athlete_id,heart_rate,spo2,skin_temperature,trigger_reason) VALUES($1,$2,100,98,36.8,'LOCAL_TEST')",
      [randomUUID(), alerted.userId],
    );
    assert.equal(
      (await new PassportService(f.prisma).getPassportByUserId(alerted.userId)).currentGti,
      30,
    );
    const empty = await f.seedAthlete();
    await f.db.query('UPDATE athlete_profiles SET current_gti=0,gti=0 WHERE id=$1', [
      empty.profileId,
    ]);
    await f.db.query(
      "INSERT INTO wearable_sessions(id,athlete_id,session_date,source) VALUES($1,$2,current_date,'DEVICE_HMAC')",
      [randomUUID(), empty.userId],
    );
    assert.equal(
      (await new PassportService(f.prisma).getPassportByUserId(empty.userId)).currentGti,
      30,
    );
  });

  it('uses the corrected starter score and watch cap in the real tournament eligibility path before stored scores catch up', async () => {
    const { userId, profileId } = await f.seedAthlete();
    await f.db.query(
      "UPDATE athlete_profiles SET date_of_birth='2000-01-01',gender='MALE',current_gti=0,gti=0 WHERE id=$1",
      [profileId],
    );
    const tx = {
      ...f.prisma,
      bracket: {
        findUnique: async () => ({
          tournamentId: 'test-tournament',
          minGti: 20,
          maxGti: 100,
          tournament: {
            status: 'REGISTRATION_OPEN',
            registrationDeadline: new Date(Date.now() + 86400000),
          },
        }),
      },
    } as unknown as Prisma.TransactionClient;
    assert.equal(
      (await readParticipationSnapshot(tx, 'test-tournament', 'test-bracket', userId)).athleteGti,
      30,
    );
    await f.db.query(
      'UPDATE athlete_profiles SET biomechanical_score=95,current_gti=95,gti=95 WHERE id=$1',
      [profileId],
    );
    assert.equal(
      (await readParticipationSnapshot(tx, 'test-tournament', 'test-bracket', userId)).athleteGti,
      35,
    );
  });

  it('applies hardware caps to existing accounts, cached passports, calculations and expired telemetry without destroying measurements', async () => {
    const { userId, profileId } = await f.seedAthlete(true);
    await f.db.query(
      "UPDATE athlete_profiles SET primary_sport='BASKETBALL',biomechanical_score=95,current_gti=95,gti=95 WHERE id=$1",
      [profileId],
    );
    const redis = memoryRedis();
    const passport = new PassportService(
      f.prisma,
      undefined,
      undefined,
      redis as unknown as RedisService,
    );
    const unconnected = await passport.getPassportByUserId(userId);
    assert.equal(unconnected.biomechanicalScore, 35);
    assert.equal(unconnected.currentGti, 35);
    assert.equal(unconnected.watchQualified, false);
    const rankings = new LeaderboardsService(f.prisma, {
      client: { zcard: async () => 0 },
    } as unknown as RedisService);
    const page = await rankings.list({
      sport: SportType.BASKETBALL,
      scope: LeaderboardScope.NATIONAL,
      limit: 20,
    });
    assert.equal(page.data[0]!.gti, 35);
    assert.equal(page.data[0]!.biomechanical_score, 35);
    const scouts = new ScoutsService(f.prisma);
    assert.equal(
      (await scouts.getScoutFeed({ sport: 'BASKETBALL', min_gti: 50, limit: 20 })).total,
      0,
    );
    await f.db.query(
      `INSERT INTO wearable_sessions(id,athlete_id,session_date,source,readings_count,hardware_observed_at)
      VALUES($1,$2,current_date,'BLE',1,now())`,
      [randomUUID(), userId],
    );
    await f.db.query(
      'UPDATE athlete_profiles SET training_consistency_score=5,wearable_score=5 WHERE id=$1',
      [profileId],
    );
    const connected = await passport.getPassportByUserId(userId);
    assert.equal(connected.biomechanicalScore, 95);
    assert.equal(connected.currentGti, 57.5);
    assert.equal(connected.watchQualified, true);
    const prospects = await scouts.getScoutFeed({ sport: 'BASKETBALL', min_gti: 50, limit: 20 });
    assert.equal(prospects.total, 1);
    assert.equal(prospects.data[0]!.biomechanical_score, 95);
    const expirations: number[] = [];
    const expiryQueue = {
      ...queue,
      enqueueWatchExpiry: async (_id: string, at: number) => {
        expirations.push(at);
      },
    } as unknown as QueueProducerService;
    const gti = new GtiService(f.prisma, leaderboards, expiryQueue, ws);
    const result = await gti.recalculateAthleteGti(userId);
    assert.equal(result.biomechanicalScore, connected.biomechanicalScore);
    assert.equal(result.gti, connected.currentGti);
    assert.equal(expirations.length, 1);
    assert.ok(expirations[0]! > Date.now());
    // Simulator activity cannot extend the separate hardware timestamp.
    await f.db.query(
      `UPDATE wearable_sessions SET source='SIMULATOR',observed_at=now(),
      hardware_observed_at=now()-interval '25 hours' WHERE athlete_id=$1`,
      [userId],
    );
    const expired = await passport.getPassportByUserId(userId);
    assert.equal(expired.biomechanicalScore, 35);
    assert.equal(expired.currentGti, 22.5);
    assert.equal(expired.watchQualified, false);
    assert.equal((await gti.recalculateAthleteGti(userId, 'WATCH_EVIDENCE_EXPIRY')).gti, 22.5);
    assert.equal(expirations.length, 1);
    const row = (
      await f.db.query<{ biomechanical_score: number }>(
        'SELECT biomechanical_score FROM athlete_profiles WHERE id=$1',
        [profileId],
      )
    ).rows[0]!;
    assert.equal(row.biomechanical_score, 95);
  });

  it('does not unlock the cap for simulator, unlabeled JWT, or empty hardware sessions', async () => {
    for (const source of ['SIMULATOR', 'ATHLETE_JWT', 'DEVICE_HMAC']) {
      const { userId, profileId } = await f.seedAthlete();
      await f.db.query('UPDATE athlete_profiles SET biomechanical_score=90 WHERE id=$1', [
        profileId,
      ]);
      await f.db.query(
        `INSERT INTO wearable_sessions(id,athlete_id,session_date,source,readings_count)
        VALUES($1,$2,current_date,$3::"TelemetrySource",1)`,
        [randomUUID(), userId, source],
      );
      const profile = await new PassportService(f.prisma).getPassportByUserId(userId);
      assert.equal(profile.biomechanicalScore, 35);
      assert.equal(profile.watchQualified, false);
    }
  });

  it('falls back from partial Redis membership and preserves count across empty cursor pages', async () => {
    const first = await f.seedAthlete(true),
      second = await f.seedAthlete(true);
    const redis = { client: { zcard: async () => 1 } } as unknown as RedisService;
    const service = new LeaderboardsService(f.prisma, redis);
    const query = { sport: SportType.CRICKET, scope: LeaderboardScope.NATIONAL, limit: 1 };
    const page = await service.list(query);
    assert.equal(page.source, 'database');
    assert.equal(page.total, 2);
    assert.equal(page.has_more, true);
    const next = await service.list({ ...query, cursor: page.nextCursor! });
    assert.equal(next.total, 2);
    assert.equal(next.data.length, 1);
    assert.notEqual(page.data[0]!.athleteId, next.data[0]!.athleteId);
    const cursor = Buffer.from(
      JSON.stringify({
        id: next.data[0]!.athleteId,
        score: 30,
        scope: 'leaderboard:global:CRICKET',
      }),
    ).toString('base64url');
    const empty = await service.list({ ...query, cursor });
    assert.equal(empty.total, 2);
    assert.deepEqual(empty.data, []);
    assert.deepEqual(
      new Set([page.data[0]!.athleteId, next.data[0]!.athleteId]),
      new Set([first.userId, second.userId]),
    );
  });

  it('does not heal an account with verified results even when passport match counters are absent', async () => {
    const { userId, profileId } = await f.seedAthlete();
    const opponent = await f.seedAthlete();
    const organizerId = randomUUID();
    await f.db.query("INSERT INTO users(id,role,updated_at) VALUES($1,'ORGANIZER',now())", [
      organizerId,
    ]);
    const tournamentId = randomUUID(),
      bracketId = randomUUID();
    await f.db.query(
      `INSERT INTO tournaments(id,organizer_id,title,sport,status,max_teams,team_size,venue_name,venue_lat,venue_lng,registration_deadline,start_date,end_date,updated_at)
      VALUES($1,$2,'Local result evidence','CRICKET','IN_PROGRESS',8,1,'Local fixture',18.52,73.85,now()+interval '1 day',now()+interval '2 days',now()+interval '3 days',now())`,
      [tournamentId, organizerId],
    );
    await f.db.query("INSERT INTO brackets(id,tournament_id,name) VALUES($1,$2,'Local bracket')", [
      bracketId,
      tournamentId,
    ]);
    await f.db.query(
      'INSERT INTO verified_match_results(id,bracket_id,reported_by_id,request_key,fingerprint,participant_athlete_ids,winner_athlete_ids) VALUES($1,$2,$3,$4,$5,$6::uuid[],$7::uuid[])',
      [
        randomUUID(),
        bracketId,
        organizerId,
        randomUUID(),
        'a'.repeat(64),
        [userId, opponent.userId],
        [opponent.userId],
      ],
    );
    await f.db.query('UPDATE athlete_profiles SET gti=0,current_gti=0 WHERE id=$1', [profileId]);
    assert.equal((await new PassportService(f.prisma).getPassportByUserId(userId)).currentGti, 0);
    assert.equal(
      (await new GtiService(f.prisma, leaderboards, queue, ws).recalculateAthleteGti(userId)).gti,
      0,
    );
  });

  it('defaults baseline restoration to dry-run and preserves healthy/zero-loss/custom scores on apply', async () => {
    const wiped = await f.seedAthlete(),
      healthy = await f.seedAthlete(),
      measured = await f.seedAthlete(),
      custom = await f.seedAthlete();
    await f.db.query('UPDATE athlete_profiles SET current_gti=0,gti=0 WHERE id=$1', [
      wiped.profileId,
    ]);
    await f.db.query(
      'UPDATE athlete_profiles SET current_gti=90,gti=90,wearable_score=0 WHERE id=$1',
      [measured.profileId],
    );
    await f.db.query(
      "INSERT INTO sport_passport_records(id,athlete_id,sport,primary_role,total_matches,updated_at) VALUES($1,$2,'CRICKET','GENERAL_ATHLETE',1,now())",
      [randomUUID(), measured.profileId],
    );
    await f.db.query(
      'UPDATE athlete_profiles SET current_gti=0,gti=0,wearable_score=72,match_perf_score=68 WHERE id=$1',
      [custom.profileId],
    );
    const txAdapter = {
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        f.db.query<T>(sql, params),
      transaction: <T>(operation: (tx: ReconcileSqlDb) => Promise<T>) =>
        f.db.transaction((tx) =>
          operation({
            query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
              tx.query<R>(sql, params),
          }),
        ),
    };
    const dry = await reconcileGtiRecords(txAdapter, {
      baselineOnly: true,
      resetUnmeasuredBaseline: true,
    });
    assert.equal(dry.updatedCount, 0);
    assert.equal(
      dry.affected.find((r) => r.profileId === wiped.profileId)?.proposedScores.currentGti,
      30,
    );
    type Scores = {
      id: string;
      current_gti: string;
      gti: number;
      wearable_score: string;
      match_perf_score: string;
    };
    const before = (
      await f.db.query<Scores>(
        'SELECT id,current_gti,gti,wearable_score,match_perf_score FROM athlete_profiles ORDER BY id',
      )
    ).rows;
    assert.equal(Number(before.find((r) => r.id === wiped.profileId)!.current_gti), 0);
    const applied = await reconcileGtiRecords(txAdapter, { apply: true, baselineOnly: true });
    assert.ok(applied.affected.find((r) => r.profileId === wiped.profileId)?.updated);
    const after = (
      await f.db.query<Scores>(
        'SELECT id,current_gti,gti,wearable_score,match_perf_score FROM athlete_profiles ORDER BY id',
      )
    ).rows;
    for (const id of [healthy.profileId, measured.profileId, custom.profileId])
      assert.deepEqual(
        after.find((r) => r.id === id),
        before.find((r) => r.id === id),
      );
    const restored = after.find((r) => r.id === wiped.profileId)!;
    assert.deepEqual(
      [restored.current_gti, restored.gti, restored.wearable_score, restored.match_perf_score].map(
        Number,
      ),
      [30, 30, 50, 50],
    );
    await assert.rejects(
      reconcileGtiRecords({ query: txAdapter.query }, { apply: true }),
      /pinned interactive transaction/,
    );
  });

  it('rolls back baseline writes if history creation fails inside the transaction', async () => {
    const { profileId } = await f.seedAthlete();
    await f.db.query('UPDATE athlete_profiles SET gti=0,current_gti=0 WHERE id=$1', [profileId]);
    const adapter: ReconcileSqlDb = {
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        f.db.query<T>(sql, params),
      transaction: (operation) =>
        f.db.transaction((tx) =>
          operation({
            query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
              if (/INSERT INTO gti_histories/.test(sql))
                throw new Error('Synthetic history failure');
              return tx.query<T>(sql, params);
            },
          }),
        ),
    };
    await assert.rejects(
      reconcileGtiRecords(adapter, { apply: true, baselineOnly: true }),
      /Synthetic history failure/,
    );
    const row = (
      await f.db.query<{ current_gti: string; gti: number }>(
        'SELECT current_gti,gti FROM athlete_profiles WHERE id=$1',
        [profileId],
      )
    ).rows[0]!;
    assert.equal(Number(row.current_gti), 0);
    assert.equal(row.gti, 0);
  });
});

describe('Wave 1: cache invalidation and transaction boundaries', () => {
  it('fences an older loader without joining it or letting its cleanup remove a newer flight', async () => {
    const redis = memoryRedis(),
      key = randomUUID();
    const old = deferred<number>(),
      current = deferred<number>();
    const started = deferred<void>();
    const stale = readThroughCache(redis, key, 120, async () => {
      started.resolve();
      return old.promise;
    });
    await started.promise;
    await invalidateCacheKeys(redis, [key]);
    let loads = 0;
    const fresh = readThroughCache(redis, key, 120, async () => {
      loads++;
      return current.promise;
    });
    await new Promise((resolve) => setImmediate(resolve));
    old.resolve(0);
    await stale;
    const joined = readThroughCache(redis, key, 120, async () => {
      loads++;
      return 99;
    });
    current.resolve(30);
    assert.deepEqual(await Promise.all([fresh, joined]), [30, 30]);
    assert.equal(loads, 1);
    assert.equal(redis.values.get(key), '30');
  });

  it('orders invalidation after an already-started Redis SET, preserving the subsequent fresh write', async () => {
    const redis = memoryRedis(),
      key = randomUUID();
    const started = deferred<void>(),
      release = deferred<void>();
    const baseSet = redis.set;
    redis.set = async (k, value) => {
      if (value === '0') {
        started.resolve();
        await release.promise;
      }
      await baseSet(k, value);
    };
    const stale = readThroughCache(redis, key, 120, async () => 0);
    await started.promise;
    const invalidated = invalidateCacheKeys(redis, [key]);
    release.resolve();
    await Promise.all([stale, invalidated]);
    assert.equal(redis.values.has(key), false);
    assert.equal(await readThroughCache(redis, key, 120, async () => 30), 30);
    assert.equal(redis.values.get(key), '30');
  });

  it('runs baseline dry-run/apply through one interactive Prisma transaction and never mutates without --apply', async () => {
    let transactions = 0,
      writes = 0;
    const queries = {
      $queryRawUnsafe: async (sql: string) => {
        if (/UPDATE|INSERT/.test(sql)) writes++;
        return [];
      },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof queries) => Promise<unknown>,
        options: { isolationLevel: string },
      ) => {
        transactions++;
        assert.equal(options.isolationLevel, 'Serializable');
        return operation(queries);
      },
      $queryRawUnsafe: async () => {
        throw new Error('Root client query escaped the transaction');
      },
      athleteProfile: { count: async () => 0 },
    } as unknown as PrismaService;
    const preview = await fixBaselinesWithPrisma(prisma);
    assert.equal(preview.dryRun, true);
    assert.equal(writes, 0);
    assert.equal(transactions, 1);
    await reconcileGtiRecords(prismaReconciliationDb(prisma), { apply: true });
    assert.equal(transactions, 2);
  });
});

describe('Wave 1: organizer summary invalidations', () => {
  it('invalidates organizer and global summaries on a context-only safety alert and bracket deletion', async () => {
    const f = await createSecurityFixture();
    const redis = memoryRedis();
    const organizerId = String(f.state.tables.tournament.get(TOURNAMENT_ID)!.organizerId);
    const safety = new SafetyService(f.prisma, f.ws, f.queue, redis as unknown as RedisService);
    await safety.processTelemetry({
      athlete_id: ATHLETE_ID,
      tournament_id: TOURNAMENT_ID,
      heart_rate: 190,
      spo2: 98,
      skin_temperature: 36.8,
      timestamp: Date.now(),
    });
    assert.equal(redis.values.get(CACHE_KEYS.organizerVersion(organizerId)), '1');
    assert.equal(redis.values.get(CACHE_KEYS.organizerVersion('GLOBAL')), '1');
    Object.assign(f.prisma.bracket, {
      delete: async ({ where }: Prisma.BracketDeleteArgs) => {
        const deleted = f.state.tables.bracket.get(String(where.id));
        f.state.tables.bracket.delete(String(where.id));
        return deleted;
      },
    });
    const brackets = new BracketsService(f.prisma, redis as unknown as RedisService);
    await brackets.deleteBracket(TOURNAMENT_ID, BRACKET_ID, {
      sub: organizerId,
      role: 'ORGANIZER',
      identityVerified: true,
    });
    assert.equal(redis.values.get(CACHE_KEYS.organizerVersion(organizerId)), '2');
    assert.equal(redis.values.get(CACHE_KEYS.organizerVersion('GLOBAL')), '2');
  });
});

describe('Wave 1: instantiated API provider graphs', () => {
  for (const embedded of [false, true])
    it(`instantiates ${embedded ? 'embedded workers' : 'API only'} with the expected processors`, async () => {
      const infrastructure: Type<unknown>[] = [
        ConfigurationModule,
        PrismaModule,
        RedisModule,
        BullmqModule,
      ];
      @Global()
      @Module({
        providers: [
          {
            provide: ConfigService,
            useValue: new ConfigService({
              app: { nodeEnv: 'test' },
              auth: { identityPepper: 'a'.repeat(64) },
            }),
          },
          { provide: PrismaService, useValue: { $queryRaw: async () => [] } },
          { provide: RedisService, useValue: { client: {} } },
          { provide: QueueProducerService, useValue: {} },
          PostgisSpatialRepository,
        ],
        exports: [
          ConfigService,
          PrismaService,
          RedisService,
          QueueProducerService,
          PostgisSpatialRepository,
        ],
      })
      class LocalInfrastructure {}
      const copies = new Map<Type<unknown>, Type<unknown>>();
      const localModule = (original: Type<unknown>): Type<unknown> => {
        if (infrastructure.includes(original)) return LocalInfrastructure;
        const existing = copies.get(original);
        if (existing) return existing;
        class LocalModule {}
        copies.set(original, LocalModule);
        Module({
          imports: (Reflect.getMetadata('imports', original) ?? []).map((entry: unknown) =>
            typeof entry === 'function' ? localModule(entry as Type<unknown>) : entry,
          ),
          providers: Reflect.getMetadata('providers', original) ?? [],
          controllers: Reflect.getMetadata('controllers', original) ?? [],
          exports: Reflect.getMetadata('exports', original) ?? [],
        })(LocalModule);
        if (Reflect.getMetadata(GLOBAL_MODULE_METADATA, original)) Global()(LocalModule);
        return LocalModule;
      };
      const metadata = createAppModuleMetadata(embedded);
      @Module({
        ...metadata,
        imports: metadata.imports!.map((entry) =>
          typeof entry === 'function' ? localModule(entry as Type<unknown>) : entry,
        ),
      } as ModuleMetadata)
      class LocalApp {}
      const app = await NestFactory.createApplicationContext(LocalApp, {
        logger: false,
        abortOnError: false,
      });
      try {
        const modules = app.get(ModulesContainer);
        for (const processor of [
          GtiCalculationProcessor,
          ScoutAlertsProcessor,
          MatchmakingProcessor,
          OutboxDispatcher,
        ]) {
          const instances = [...modules.values()]
            .flatMap((module) => [...module.providers.values()])
            .filter((provider) => provider.instance instanceof processor);
          assert.equal(instances.length, embedded ? 1 : 0, processor.name);
        }
        assert.ok(app.get(GtiService) instanceof GtiService);
      } finally {
        await app.close();
      }
    });
});
