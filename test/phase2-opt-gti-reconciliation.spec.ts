import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { GovIdType, Prisma, SportType } from '@prisma/client';
import { createAuthFixture } from './helpers/auth-passport.fixture';
import { ATHLETE_ID, createSecurityFixture } from './helpers/security-gti.fixture';
import { resolveProfileComponentScores } from '../src/modules/gti/gti-score-reconciliation';

describe('Phase 2 Task 2: GTI Data-Model Baseline & Main Formula Verification', () => {
  it('initializes 30.0 GTI and 50.0 component defaults at registration matching main baseline', async () => {
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
    assert.strictEqual(capturedCreateData?.currentGti, 30);
    assert.strictEqual(capturedCreateData?.wearableScore, 50);
    assert.strictEqual(capturedCreateData?.matchPerfScore, 50);
    assert.strictEqual(Number(f.state.profile?.currentGti), 30);
    assert.strictEqual(Number(f.state.profile?.wearableScore), 50);
    assert.strictEqual(Number(f.state.profile?.matchPerfScore), 50);
    const passport = await f.passports.getPassportByUserId(result.user.id);
    assert.strictEqual(passport.currentGti, 30);
    assert.strictEqual(passport.biomechanicalScore, 0);
    assert.strictEqual(passport.wearableScore, 50);
    assert.strictEqual(passport.matchPerfScore, 50);
  });

  it('preserves the main GTI formula with partial telemetry weights', async () => {
    // Drill-only athlete (80 bio, 0 wearable, 0 match) with main formula gets 37.34 because (0 !== 50) includes match weight
    const drillOnly = await createSecurityFixture();
    drillOnly.setProfile({
      biomechanicalScore: 80,
      trainingConsistencyScore: 0,
      matchPerformanceScore: 0,
    });
    const drillId = randomUUID();
    drillOnly.state.tables.drillSubmission.set(drillId, { id: drillId, athleteId: ATHLETE_ID });
    const drillGti = await drillOnly.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(drillGti.gti, 37.34);
    assert.deepEqual(drillGti.evidence, {
      biomechanical: 'VERIFIED',
      wearable: 'NOT_AVAILABLE',
      matchPerformance: 'NOT_AVAILABLE',
    });
    assert.equal(drillGti.provisional, true);

    // Wearable-only athlete (0 bio, 45 wearable, 50 match default)
    const wearableOnly = await createSecurityFixture();
    wearableOnly.setProfile({
      biomechanicalScore: 0,
      trainingConsistencyScore: 45,
      matchPerformanceScore: 50,
    });
    const sessionId = randomUUID();
    wearableOnly.state.tables.wearableSession.set(sessionId, { id: sessionId, athleteId: ATHLETE_ID });
    const wearableGti = await wearableOnly.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(wearableGti.gti, 45);
    assert.equal(wearableGti.provisional, false);
  });

  it('reads baseline defaults on passports directly as on main', () => {
    // Custom historical non-50 legacy score is preserved
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

  describe('PostgreSQL schema defaults & baseline integrity', () => {
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

    it('verifies baseline schema defaults are 30.00 / 50.00 / 50.00 as on main', async () => {
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
      assert.equal(Number(freshRow.current_gti), 30);
      assert.equal(Number(freshRow.wearable_score), 50);
      assert.equal(Number(freshRow.match_perf_score), 50);
    });
  });
});
