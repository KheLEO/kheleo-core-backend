import 'reflect-metadata';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, UserRole } from '@prisma/client';
import { LeaderboardScope } from '../src/modules/leaderboards/leaderboards.dto';
import { ScoutsService } from '../src/modules/scouts/scouts.service';
import { createSecurityFixture, ATHLETE_ID, OPPONENT_ID } from './helpers/security-gti.fixture';
import {
  createAuthFixture,
  createAuthPassportApp,
  fixtureToken,
  TEST_USER_ID,
  TEST_OTHER_ID,
} from './helpers/auth-passport.fixture';

const profileInput = {
  primarySport: 'CRICKET' as const,
  district: 'Shared',
  state: 'Maharashtra',
  isScoutSearchable: true,
};
describe('Prompt 3 scoped scouting contracts', () => {
  it('indexes ALL and sport-specific scopes, traverses equal scores by UUID, and removes moved/deactivated members', async () => {
    const f = await createSecurityFixture();
    for (const id of [ATHLETE_ID, OPPONENT_ID]) {
      f.setProfile(
        { gti: 90, currentGti: new Prisma.Decimal(90), state: 'Maharashtra', district: 'Shared' },
        id,
      );
      await f.services.leaderboards.syncAthlete(id);
    }
    const query = {
      scope: LeaderboardScope.DISTRICT,
      state: 'Maharashtra',
      district: 'Shared',
      limit: 1,
    };
    const first = await f.services.leaderboards.list(query);
    assert.equal(first.success, true);
    assert.equal(first.total, 2);
    assert.equal(first.has_more, true);
    assert.equal(first.data[0]?.athlete_id, OPPONENT_ID);
    assert.ok(first.data[0]?.profile_id);
    assert.equal(first.data[0]?.total_matches, 0);
    const second = await f.services.leaderboards.list({ ...query, cursor_id: first.next_cursor! });
    assert.equal(second.data[0]?.athlete_id, ATHLETE_ID);
    assert.equal(second.data[0]?.rank, 2);
    assert.equal(second.has_more, false);
    assert.equal(f.zsets.get('leaderboard:global:ALL')?.size, 2);
    f.setProfile({ state: 'Karnataka', primarySport: 'FOOTBALL' });
    await f.services.leaderboards.syncAthlete(ATHLETE_ID);
    assert.equal(
      f.zsets.get('leaderboard:district:Maharashtra:Shared:ALL')?.has(ATHLETE_ID),
      false,
    );
    assert.equal(
      f.zsets.get('leaderboard:district:Karnataka:Shared:FOOTBALL')?.has(ATHLETE_ID),
      true,
    );
    f.state.tables.user.get(ATHLETE_ID)!.isActive = false;
    await f.services.leaderboards.syncAthlete(ATHLETE_ID);
    assert.equal(f.zsets.get('leaderboard:global:ALL')?.has(ATHLETE_ID), false);
    await assert.rejects(
      f.services.leaderboards.list({
        ...query,
        cursor_id: first.data[0]!.profile_id,
        state: 'Karnataka',
      }),
      /outside/,
    );
  });
  it('paginates tied scout prospects using current GTI descending and profile UUID ascending', async () => {
    const f = await createSecurityFixture();
    for (const id of [ATHLETE_ID, OPPONENT_ID])
      f.setProfile({ gti: 99, currentGti: new Prisma.Decimal(87) }, id);
    const service = new ScoutsService(f.prisma);
    const first = await service.getScoutFeed({ limit: 1 });
    const second = await service.getScoutFeed({ limit: 1, cursor_id: first.next_cursor! });
    const profiles = [f.profile().id, f.profile(OPPONENT_ID).id].sort();
    assert.deepEqual([first.data[0]?.profile_id, second.data[0]?.profile_id], profiles);
    assert.equal(second.next_cursor, null);
  });
  it('aggregates every monitored sample while preserving simulator and baseline provenance', async () => {
    const f = await createSecurityFixture();
    const base = {
      athlete_id: ATHLETE_ID,
      timestamp: Date.now(),
      spo2: 98,
      skin_temperature: 36.8,
    };
    await f.services.safety.processTelemetry(
      { ...base, heart_rate: 100, baseline_fields: ['spo2'] },
      'BLE',
    );
    await f.services.safety.processTelemetry({ ...base, heart_rate: 140, spo2: 96 }, 'SIMULATOR');
    const summary = await f.prisma.wearableSession.aggregate({
      where: { athleteId: ATHLETE_ID },
      _sum: {
        readingsCount: true,
        heartRateSum: true,
        spo2Sum: true,
        simulatorReadings: true,
        baselineSpo2Readings: true,
      },
    });
    assert.deepEqual(summary._sum, {
      readingsCount: 2,
      heartRateSum: 240,
      spo2Sum: 194,
      simulatorReadings: 1,
      baselineSpo2Readings: 1,
    });
  });
  it('persists all three outreach actions, isolates scout histories, and rechecks opt-out before idempotent replay', async () => {
    const f = createAuthFixture();
    await f.passports.upsertPassport(TEST_USER_ID, profileInput);
    f.state.profile!.userId = TEST_OTHER_ID;
    f.state.user.role = UserRole.SCOUT;
    const app = await createAuthPassportApp(f);
    const headers = {
      authorization: `Bearer ${fixtureToken(UserRole.SCOUT)}`,
      'idempotency-key': randomUUID(),
    };
    const url = `/api/v1/scouts/dossiers/${TEST_OTHER_ID}/outreach`;
    try {
      const body = {
        actionType: 'OFFER_TRIAL',
        notes: 'Invite to the campus assessment',
        organizationName: 'Campus Academy',
      };
      const trial = await app.inject({ method: 'POST', url, headers, payload: body });
      assert.equal(trial.statusCode, 201, trial.body);
      const retry = await app.inject({ method: 'POST', url, headers, payload: body });
      assert.equal(retry.statusCode, 201, retry.body);
      for (const actionType of ['SPONSORSHIP_INQUIRY', 'SHORTLIST_BOOKMARK']) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { actionType },
        });
        assert.equal(response.statusCode, 201, response.body);
      }
      const saved = [...f.state.dossiers.values()][0]!;
      assert.equal(saved.isShortlisted, true);
      assert.equal(saved.pipelineStatus, 'SCHOLARSHIP_OUTREACH');
      assert.equal(saved.organizationName, 'Campus Academy');
      assert.equal((saved.outreachHistory as unknown[]).length, 3);
      const dossier = await f.dossiers.getDossier(TEST_OTHER_ID, {
        sub: TEST_USER_ID,
        role: 'SCOUT',
      });
      assert.equal(dossier.scout_outreach?.history.length, 3);
      const different = await f.dossiers.getDossier(TEST_OTHER_ID, {
        sub: randomUUID(),
        role: 'SCOUT',
      });
      assert.equal(different.scout_outreach, null);
      f.state.profile!.isScoutSearchable = false;
      const withdrawn = await app.inject({ method: 'POST', url, headers, payload: body });
      assert.equal(withdrawn.statusCode, 403, withdrawn.body);
      f.state.user.role = UserRole.ORGANIZER;
      const organizer = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${TEST_OTHER_ID}/dossier`,
        headers: { authorization: `Bearer ${fixtureToken(UserRole.ORGANIZER)}` },
      });
      assert.equal(organizer.statusCode, 403, organizer.body);
    } finally {
      await app.close();
    }
  });
  it('returns complete chronological GTI history, only verified signed drills, and explicit missing telemetry', async () => {
    const f = createAuthFixture();
    await f.passports.upsertPassport(TEST_USER_ID, profileInput);
    for (let index = 29; index >= 0; index--)
      f.state.profile!.gtiHistories.push({
        id: randomUUID(),
        athleteId: f.state.profile!.id,
        compositeGti: new Prisma.Decimal(index),
        biomechanicalScore: new Prisma.Decimal(index),
        wearableScore: new Prisma.Decimal(index),
        matchScore: new Prisma.Decimal(index),
        calculationFactors: { triggerType: 'MATCH_COMPLETED' },
        calculatedAt: new Date(Date.UTC(2025, 0, index + 1)),
      });
    for (let index = 0; index < 12; index++)
      f.state.user.drillSubmissions.push({
        id: randomUUID(),
        athleteId: TEST_USER_ID,
        sport: 'CRICKET',
        drillType: 'CRICKET_BOWLING',
        formScore: 80,
        framesAnalyzed: 40,
        flawFlags: [],
        jointAnglesSummary: {},
        signatureHash: 'a'.repeat(64),
        signatureVersion: 'FULL_V2',
        clientPoseDigest: null,
        metadataVerified: index !== 11,
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      });
    const data = await f.dossiers.getDossier(TEST_USER_ID, { sub: TEST_USER_ID, role: 'ATHLETE' });
    assert.equal(data.gti_history.length, 30);
    assert.equal(data.gti_history[0]?.gti, 0);
    assert.equal(data.gti_history.at(-1)?.gti, 29);
    assert.equal(data.gti_history[0]?.trigger_type, 'MATCH_COMPLETED');
    assert.equal(data.recent_drills.length, 10);
    assert.equal(data.recent_drills[0]?.signature_hash_prefix, 'a'.repeat(12));
    assert.equal(data.recent_drills[0]?.frames_analyzed, 40);
    assert.equal(data.wearable_summary.avg_heart_rate, null);
    assert.equal(data.wearable_summary.avg_spo2, null);
    assert.equal(data.scout_outreach, null);
  });
});
