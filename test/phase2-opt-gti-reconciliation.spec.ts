import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { GovIdType, Prisma, SportType } from '@prisma/client';
import { createAuthFixture, TEST_DOCUMENT } from './helpers/auth-passport.fixture';
import { ATHLETE_ID, OPPONENT_ID, createSecurityFixture } from './helpers/security-gti.fixture';
import { resolveProfileComponentScores } from '../src/modules/gti/gti-score-reconciliation';
import { reconcileGtiRecords } from '../scripts/reconcile-gti-scores';

describe('Phase 2 Task 2: GTI Data-Model Reconciliation & Bug Fix', () => {
  it('initializes coherent 0.0 GTI and component defaults at registration with zero baseline drift', async () => {
    const f = createAuthFixture();
    let capturedCreateData: Record<string, unknown> | undefined;
    const prismaMock = f.auth['prisma'] as unknown as {
      athleteProfile: Record<string, unknown>;
    };
    prismaMock.athleteProfile.create = async ({ data }: { data: Record<string, unknown> }) => {
      capturedCreateData = data;
      const upsert = prismaMock.athleteProfile.upsert as (args: {
        create: Record<string, unknown>;
      }) => Promise<unknown>;
      return upsert({ create: data });
    };

    const result = await f.auth.register({
      email: 'new-reconciled@fixture.test',
      governmentId: { idType: GovIdType.AADHAAR, idNumber: '987612345678' },
      profile: {
        dateOfBirth: '2006-05-01',
        gender: 'MALE',
        primarySport: SportType.CRICKET,
        district: 'Pune',
        state: 'Maharashtra',
      },
    });
    assert.ok(result.user.id);
    assert.strictEqual(capturedCreateData?.currentGti, 0);
    assert.strictEqual(capturedCreateData?.wearableScore, 0);
    assert.strictEqual(capturedCreateData?.matchPerfScore, 0);
    assert.strictEqual(Number(f.state.profile?.currentGti), 0);
    assert.strictEqual(Number(f.state.profile?.wearableScore), 0);
    assert.strictEqual(Number(f.state.profile?.matchPerfScore), 0);
    const passport = await f.passports.getPassportByUserId(result.user.id);
    assert.strictEqual(passport.currentGti, 0);
    assert.strictEqual(passport.biomechanicalScore, 0);
    assert.strictEqual(passport.wearableScore, 0);
    assert.strictEqual(passport.matchPerfScore, 0);
  });

  it('fixes the matchPerformanceScore !== 50 bug so drill-only and wearable-only athletes receive full Partial Telemetry weights', async () => {
    // Drill-only athlete (80 bio, 0 wearable, 0 match) previously got 37.34 because (0 !== 50) added w3=0.40*0
    const drillOnly = await createSecurityFixture();
    drillOnly.setProfile({
      biomechanicalScore: 80,
      trainingConsistencyScore: 0,
      matchPerformanceScore: 0,
    });
    const drillId = randomUUID();
    drillOnly.state.tables.drillSubmission.set(drillId, { id: drillId, athleteId: ATHLETE_ID });
    const drillGti = await drillOnly.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(drillGti.gti, 80);
    assert.deepEqual(drillGti.evidence, {
      biomechanical: 'VERIFIED',
      wearable: 'NOT_AVAILABLE',
      matchPerformance: 'NOT_AVAILABLE',
    });
    assert.equal(drillGti.provisional, false);

    // Wearable-only athlete (0 bio, 45 wearable, 0 match)
    const wearableOnly = await createSecurityFixture();
    wearableOnly.setProfile({
      biomechanicalScore: 0,
      trainingConsistencyScore: 45,
      matchPerformanceScore: 0,
    });
    const sessionId = randomUUID();
    wearableOnly.state.tables.wearableSession.set(sessionId, { id: sessionId, athleteId: ATHLETE_ID });
    const wearableGti = await wearableOnly.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(wearableGti.gti, 45);
    assert.equal(wearableGti.provisional, false);
  });

  it('suppresses stale synthetic 50.0 defaults on passports once measured telemetry exists while preserving custom legacy scores', () => {
    // Drill-only athlete whose legacy columns still hold stale 50.0 onboarding defaults
    const reconciled = resolveProfileComponentScores(
      {
        gti: 80,
        currentGti: new Prisma.Decimal(80),
        biomechanicalScore: 80,
        trainingConsistencyScore: 0,
        wearableScore: new Prisma.Decimal(50),
        matchPerformanceScore: 0,
        matchPerfScore: new Prisma.Decimal(50),
      },
      { preserveUnmeasuredOnboardingDefaults: true },
    );
    assert.deepEqual(reconciled, {
      currentGti: 80,
      biomechanicalScore: 80,
      wearableScore: 0,
      matchPerfScore: 0,
    });

    // Custom historical non-50 legacy score is preserved (never wiped blindly)
    const customLegacy = resolveProfileComponentScores(
      {
        gti: 0,
        currentGti: new Prisma.Decimal(62),
        biomechanicalScore: 0,
        trainingConsistencyScore: 0,
        wearableScore: new Prisma.Decimal(72),
        matchPerformanceScore: 0,
        matchPerfScore: new Prisma.Decimal(68),
      },
      { preserveUnmeasuredOnboardingDefaults: true },
    );
    assert.deepEqual(customLegacy, {
      currentGti: 62,
      biomechanicalScore: 0,
      wearableScore: 72,
      matchPerfScore: 68,
    });
  });

  describe('Migrated PostgreSQL dry-run vs verified GTI reconciliation & eligibility impact', () => {
    const db = new PGlite({ extensions: { postgis } });

    before(async () => {
      const root = resolve(__dirname, '../prisma/migrations');
      for (const dir of readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        await db.exec(readFileSync(resolve(root, dir.name, 'migration.sql'), 'utf8'));
      }
    });

    after(async () => {
      await db.close();
    });

    it('aligns schema defaults to 0.00, preserves custom legacy scores, recalculates diluted drill scores, and flags bracket eligibility deltas', async () => {
      const organizerId = randomUUID();
      await db.query("INSERT INTO users(id, role, updated_at) VALUES($1, 'ORGANIZER', now())", [
        organizerId,
      ]);

      // 1. Verify post-migration default columns are 0.00
      const freshUser = randomUUID();
      await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [freshUser]);
      await db.query(
        "INSERT INTO athlete_profiles(id, user_id, district, state, updated_at) VALUES($1, $2, 'Pune', 'Maharashtra', now())",
        [randomUUID(), freshUser],
      );
      const freshRow = (
        await db.query<{
          current_gti: string;
          wearable_score: string;
          match_perf_score: string;
        }>('SELECT current_gti, wearable_score, match_perf_score FROM athlete_profiles WHERE user_id=$1', [
          freshUser,
        ])
      ).rows[0]!;
      assert.equal(Number(freshRow.current_gti), 0);
      assert.equal(Number(freshRow.wearable_score), 0);
      assert.equal(Number(freshRow.match_perf_score), 0);

      // 2. Seed pre-migration synthetic 30/50/50 athlete enrolled in a min_gti=20 bracket
      const unmeasuredUser = randomUUID();
      const unmeasuredProfile = randomUUID();
      await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [unmeasuredUser]);
      await db.query(
        `INSERT INTO athlete_profiles(id, user_id, primary_sport, district, state, current_gti, gti, wearable_score, match_perf_score, updated_at)
         VALUES($1, $2, 'CRICKET', 'Pune', 'Maharashtra', 30.00, 0, 50.00, 50.00, now())`,
        [unmeasuredProfile, unmeasuredUser],
      );
      const tournamentId = randomUUID();
      const bracketId = randomUUID();
      await db.query(
        `INSERT INTO tournaments(id, organizer_id, name, title, sport, max_teams, team_size, venue_name, venue_lat, venue_lng, registration_deadline, start_date, end_date, updated_at)
         VALUES($1, $2, 'Tiered Cup', 'Tiered Cup', 'CRICKET', 16, 1, 'Pune Arena', 18.52, 73.85, now(), now(), now() + interval '1 day', now())`,
        [tournamentId, organizerId],
      );
      await db.query(
        `INSERT INTO brackets(id, tournament_id, name, min_gti, max_gti, max_teams)
         VALUES($1, $2, 'Starter 20-45', 20.00, 45.00, 16)`,
        [bracketId, tournamentId],
      );
      await db.query(
        `INSERT INTO registrations(id, bracket_id, user_id, status)
         VALUES($1, $2, $3, 'CONFIRMED')`,
        [randomUUID(), bracketId, unmeasuredUser],
      );

      // 3. Seed drill-only athlete whose stored GTI=37.34 suffered from the (0 !== 50) bug vs peer at 55.0
      const drillUser = randomUUID();
      const drillProfile = randomUUID();
      await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [drillUser]);
      await db.query(
        `INSERT INTO athlete_profiles(id, user_id, primary_sport, district, state, gti, current_gti, biomechanical_score, training_consistency_score, match_performance_score, wearable_score, match_perf_score, updated_at)
         VALUES($1, $2, 'CRICKET', 'Pune', 'Maharashtra', 37.34, 37.34, 80, 0, 0, 50.00, 50.00, now())`,
        [drillProfile, drillUser],
      );
      await db.query(
        `INSERT INTO drill_submissions(id, athlete_id, sport, drill_type, form_score, frames_analyzed, flaw_flags, joint_angles_summary, signature_hash)
         VALUES($1, $2, 'CRICKET', 'BOWLING', 80, 120, '[]', '{}', $3)`,
        [randomUUID(), drillUser, 'b'.repeat(64)],
      );

      // Peer athlete at GTI 55 (initially ranked #1 ahead of drillUser 37.34; after reconciliation drillUser becomes 80 -> #1)
      const peerUser = randomUUID();
      await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [peerUser]);
      await db.query(
        `INSERT INTO athlete_profiles(id, user_id, primary_sport, district, state, gti, current_gti, biomechanical_score, training_consistency_score, match_performance_score, updated_at)
         VALUES($1, $2, 'CRICKET', 'Pune', 'Maharashtra', 55, 55.00, 55, 55, 55, now())`,
        [randomUUID(), peerUser],
      );

      // 4. Seed custom legacy non-50 athlete (wearable_score=72, training_consistency_score=0) - must NOT be overwritten
      const legacyUser = randomUUID();
      const legacyProfile = randomUUID();
      await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [legacyUser]);
      await db.query(
        `INSERT INTO athlete_profiles(id, user_id, primary_sport, district, state, gti, current_gti, wearable_score, match_perf_score, updated_at)
         VALUES($1, $2, 'CRICKET', 'Pune', 'Maharashtra', 0, 62.00, 72.00, 68.00, now())`,
        [legacyProfile, legacyUser],
      );

      const dryRun = await reconcileGtiRecords(db, {
        apply: false,
        resetUnmeasuredBaseline: true,
      });
      const drillEntry = dryRun.affected.find((e) => e.userId === drillUser)!;
      assert.ok(drillEntry.categories.includes('MATCH_ACTIVITY_BUG_0_NEQ_50'));
      assert.equal(drillEntry.legacyBuggyGti, 37.34);
      assert.equal(drillEntry.recalculatedGti, 80);
      assert.equal(drillEntry.sportRankBefore, 3);
      assert.equal(drillEntry.sportRankAfter, 1);

      const unmeasuredEntry = dryRun.affected.find((e) => e.userId === unmeasuredUser)!;
      assert.ok(unmeasuredEntry.categories.includes('UNMEASURED_SYNTHETIC_BASELINE'));
      assert.equal(unmeasuredEntry.affectedRegistrations.length, 1);
      assert.equal(unmeasuredEntry.affectedRegistrations[0]!.eligibleBefore, true);
      assert.equal(unmeasuredEntry.affectedRegistrations[0]!.eligibleAfter, false);

      // Apply without wiping custom legacy score
      const applied = await reconcileGtiRecords(db, {
        apply: true,
        resetUnmeasuredBaseline: false,
      });
      assert.equal(applied.customLegacyReviewCount, 1);

      const updatedDrill = (
        await db.query<{
          gti: number;
          current_gti: string;
          wearable_score: string;
          match_perf_score: string;
        }>('SELECT gti, current_gti, wearable_score, match_perf_score FROM athlete_profiles WHERE id=$1', [
          drillProfile,
        ])
      ).rows[0]!;
      assert.equal(updatedDrill.gti, 80);
      assert.equal(Number(updatedDrill.current_gti), 80);
      assert.equal(Number(updatedDrill.wearable_score), 0);
      assert.equal(Number(updatedDrill.match_perf_score), 0);

      // Custom legacy score stayed intact
      const preservedLegacy = (
        await db.query<{ wearable_score: string; current_gti: string }>(
          'SELECT wearable_score, current_gti FROM athlete_profiles WHERE id=$1',
          [legacyProfile],
        )
      ).rows[0]!;
      assert.equal(Number(preservedLegacy.wearable_score), 72);
      assert.equal(Number(preservedLegacy.current_gti), 62);
    });
  });
});
