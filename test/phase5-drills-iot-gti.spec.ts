import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Job } from 'bullmq';
import { DrillSignatureVersion, Prisma, SportType, TelemetrySource } from '@prisma/client';
import {
  DrillSignatureGuard,
  canonicalDrillPayload,
  fullDrillPayload,
} from '../src/modules/drills/guards/drill-signature.guard';
import { SubmitDrillDto } from '../src/modules/drills/dto/submit-drill.dto';
import { ScoutAlertsProcessor } from '../src/modules/gti/processors/scout-alerts.processor';
import { ScoutAlertPayload } from '../src/infrastructure/queues/queue-producer.service';
import { HeatmapsService } from '../src/modules/heatmaps/heatmaps.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import {
  ATHLETE_ID,
  OPPONENT_ID,
  ORGANIZER_ID,
  UMPIRE_ID,
  MATCH_ID,
  DRILL_SECRET,
  createSecurityFixture,
  createSecurityApp,
} from './helpers/security-gti.fixture';
import { BRACKET_ID, TOURNAMENT_ID } from './helpers/competition.fixture';

function drill(overrides: Partial<SubmitDrillDto> = {}): SubmitDrillDto {
  return {
    athlete_id: ATHLETE_ID,
    sport: SportType.CRICKET,
    drill_type: 'BOWLING',
    form_score: 96,
    frames_analyzed: 300,
    flaw_flags: [],
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}
function signature(payload: string): string {
  return createHmac('sha256', DRILL_SECRET).update(payload).digest('hex');
}
function context(body: unknown, hash: string, hint?: string) {
  const request = {
    body,
    user: { sub: ATHLETE_ID, role: 'ATHLETE' },
    headers: { 'x-drill-signature': hash, ...(hint ? { 'x-drill-signed-fields': hint } : {}) },
    drillSignatureVersion: undefined as DrillSignatureVersion | undefined,
  };
  return {
    request,
    execution: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}
function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    athlete_id: ATHLETE_ID,
    heart_rate: 90,
    spo2: 98,
    skin_temperature: 36.8,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Phase 4 drill integrity and measured GTI pipelines', () => {
  it('normalizes full HMAC hex and persists verified metadata; replay casing cannot create another submission', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    try {
      const dto = drill();
      const hash = signature(fullDrillPayload(ATHLETE_ID, dto));
      const headers = {
        authorization: `Bearer ${f.token()}`,
        'x-drill-signature': `  ${hash.toUpperCase()}  `,
        'x-drill-signed-fields': 'full',
        'idempotency-key': randomUUID(),
      };
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/drills/submit',
        headers,
        payload: dto,
      });
      assert.equal(response.statusCode, 200, response.body);
      const stored = [...f.state.tables.drillSubmission.values()][0]!;
      assert.equal(stored.signatureHash, hash);
      assert.equal(stored.signatureVersion, 'FULL');
      assert.equal(stored.metadataVerified, true);
      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/drills/submit',
        headers: { ...headers, 'idempotency-key': randomUUID(), 'x-drill-signature': hash },
        payload: dto,
      });
      assert.equal(replay.statusCode, 409, replay.body);
      assert.equal(f.state.tables.drillSubmission.size, 1);
      assert.equal(f.profile().biomechanicalScore, 96);
      assert.ok(
        f.state.reads
          .filter((row) => row.model === 'drillSubmission')
          .every((row) => row.inTransaction),
      );
    } finally {
      await app.close();
    }
  });

  it('rejects Probe 2, wrong types, out-of-range frames, changed metadata, and attempted full-to-legacy downgrade', async () => {
    const f = await createSecurityFixture();
    const guard = new DrillSignatureGuard(f.auth.config, f.prisma);
    const dto = drill();
    const full = signature(fullDrillPayload(ATHLETE_ID, dto));
    const legacy = signature(`${ATHLETE_ID}:${dto.drill_type}:${dto.form_score}:${dto.timestamp}`);
    const mutations: unknown[] = [
      { ...dto, sport: 'FOOTBALL', frames_analyzed: 999999 },
      { ...dto, sport: 'FOOTBALL' },
      { ...dto, frames_analyzed: 301 },
      { ...dto, flaw_flags: ['changed'] },
      { ...dto, frames_analyzed: 1.5 },
      { ...dto, frames_analyzed: 18001 },
      { ...dto, frames_analyzed: '300' },
      { ...dto, flaw_flags: {} },
      { ...dto, flaw_flags: [1] },
      { ...dto, joint_angles_summary: [] },
      { ...dto, sport: 'INVALID' },
    ];
    for (const mutated of mutations)
      await assert.rejects(
        () => guard.canActivate(context(mutated, full, 'full').execution),
        ForbiddenException,
      );
    await assert.rejects(
      () => guard.canActivate(context(dto, legacy, 'full').execution),
      ForbiddenException,
    );
    const old = context(dto, legacy);
    assert.equal(await guard.canActivate(old.execution), true);
    assert.equal(old.request.drillSignatureVersion, 'LEGACY');
    await assert.rejects(
      () => guard.canActivate(context({ ...dto, athlete_id: OPPONENT_ID }, legacy).execution),
      ForbiddenException,
    );
    await assert.rejects(
      () =>
        guard.canActivate(context(drill({ timestamp: Date.now() / 1000 - 350 }), legacy).execution),
      /anti-replay/,
    );
    for (const [type, sport] of [
      ['SMASH', 'CRICKET'],
      ['DROP', 'FOOTBALL'],
      ['STRIKE', 'BADMINTON'],
      ['DRIBBLE', 'CRICKET'],
      ['WICKET', 'FOOTBALL'],
    ])
      await assert.rejects(
        () => guard.canActivate(context({ ...dto, drill_type: type, sport }, legacy).execution),
        /does not match/,
      );
  });

  it('binds joint summaries with canonical FULL_V2 signatures and marks legacy metadata unverified', async () => {
    const f = await createSecurityFixture();
    const guard = new DrillSignatureGuard(f.auth.config, f.prisma);
    const dto = drill({ joint_angles_summary: { hip: 90, knee: 40 } });
    const hash = signature(canonicalDrillPayload(ATHLETE_ID, dto));
    const valid = context({ ...dto, joint_angles_summary: { knee: 40, hip: 90 } }, hash, 'full-v2');
    assert.equal(await guard.canActivate(valid.execution), true);
    assert.equal(valid.request.drillSignatureVersion, 'FULL_V2');
    await assert.rejects(
      () =>
        guard.canActivate(
          context({ ...dto, joint_angles_summary: { hip: 99, knee: 40 } }, hash, 'full-v2')
            .execution,
        ),
      ForbiddenException,
    );
    await f.services.drills.submitDrill(
      ATHLETE_ID,
      drill(),
      signature('old'),
      DrillSignatureVersion.LEGACY,
    );
    assert.equal([...f.state.tables.drillSubmission.values()][0]!.metadataVerified, false);
  });

  it('re-reads the drill average on serializable retries, preserving the committed concurrent submission', async () => {
    const f = await createSecurityFixture();
    f.state.tables.drillSubmission.set('first', {
      id: 'first',
      athleteId: ATHLETE_ID,
      formScore: 20,
      signatureHash: signature('first'),
    });
    f.setProfile({ biomechanicalScore: 20 });
    f.state.failCommit = true;
    f.state.onBegin = (attempt) => {
      if (attempt === 2) {
        f.state.tables.drillSubmission.set('other', {
          id: 'other',
          athleteId: ATHLETE_ID,
          formScore: 80,
          signatureHash: signature('other'),
        });
        f.setProfile({ biomechanicalScore: 50 });
      }
    };
    const result = await f.services.drills.submitDrill(
      ATHLETE_ID,
      drill({ form_score: 100 }),
      signature('new'),
    );
    assert.equal(result.current_biomechanical_score, 66.67);
    assert.equal(f.state.tables.drillSubmission.size, 3);
    assert.equal(f.state.jobs.length, 1);
    assert.ok(
      f.state.reads
        .filter((read) => read.model === 'athleteProfile')
        .every((read) => read.inTransaction),
    );
  });

  it('records bounded athlete telemetry, rewards one monitored day once, and queues wearable GTI recalculation', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const headers = { authorization: `Bearer ${f.token()}`, 'idempotency-key': randomUUID() };
    try {
      for (let n = 0; n < 2; n++) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/safety/telemetry-webhook',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: telemetry(),
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json<{ status: string }>().status, 'NORMAL');
      }
      assert.equal(f.state.tables.wearableSession.size, 1);
      assert.equal(f.profile().trainingConsistencyScore, 5);
      assert.equal(f.state.jobs[0]?.trigger, 'WEARABLE_SYNC');
      assert.equal([...f.state.tables.wearableSession.values()][0]?.source, 'ATHLETE_JWT');
      for (const invalid of [
        { heart_rate: 19 },
        { heart_rate: 261 },
        { spo2: 49 },
        { spo2: 101 },
        { skin_temperature: 24 },
        { skin_temperature: 46 },
        { timestamp: undefined },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/safety/telemetry-webhook',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: telemetry(invalid),
        });
        assert.equal(response.statusCode, 400, response.body);
      }
      const other = await app.inject({
        method: 'POST',
        url: '/api/v1/safety/telemetry-webhook',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: telemetry({ athlete_id: OPPONENT_ID }),
      });
      assert.equal(other.statusCode, 403);
      const unsigned = await app.inject({
        method: 'POST',
        url: '/api/v1/safety/telemetry-webhook',
        headers: { 'idempotency-key': randomUUID() },
        payload: telemetry(),
      });
      assert.equal(unsigned.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  it('accepts a device HMAC and rejects body tampering and stale telemetry', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const dto = telemetry();
    const hash = createHmac('sha256', 'fixture-telemetry-service-secret')
      .update(JSON.stringify(dto))
      .digest('hex');
    try {
      const headers = { 'x-device-signature': hash, 'idempotency-key': randomUUID() };
      const valid = await app.inject({
        method: 'POST',
        url: '/api/v1/safety/telemetry-webhook',
        headers,
        payload: dto,
      });
      assert.equal(valid.statusCode, 200, valid.body);
      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/safety/telemetry-webhook',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { ...dto, heart_rate: 201 },
      });
      assert.equal(bad.statusCode, 403);
      await assert.rejects(
        f.services.safety.processTelemetry({ ...dto, timestamp: Date.now() - 301000 }),
        /300 seconds/,
      );
    } finally {
      await app.close();
    }
  });

  it('pauses only a participating active match, fills context, limits alert access, acknowledges, and resumes', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const athleteHeaders = {
      authorization: `Bearer ${f.token()}`,
      'idempotency-key': randomUUID(),
    };
    const operatorHeaders = {
      authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
      'idempotency-key': randomUUID(),
    };
    try {
      const pause = await app.inject({
        method: 'POST',
        url: '/api/v1/safety/telemetry-webhook',
        headers: athleteHeaders,
        payload: telemetry({ heart_rate: 205, match_id: MATCH_ID }),
      });
      assert.equal(pause.statusCode, 200, pause.body);
      assert.equal(pause.json<{ status: string }>().status, 'MATCH_PAUSED');
      assert.equal(f.state.tables.match.get(MATCH_ID)?.status, 'PAUSED_SAFETY');
      assert.equal(f.state.pauses.length, 1);
      assert.equal(f.state.pauses[0]?.tournament_id, TOURNAMENT_ID);
      assert.equal(f.state.pauses[0]?.bracket_id, BRACKET_ID);
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/safety/alerts?tournament_id=${TOURNAMENT_ID}&severity=CRITICAL`,
        headers: operatorHeaders,
      });
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(list.json<{ data: unknown[] }>().data.length, 1);
      const blocked = await app.inject({
        method: 'POST',
        url: `/api/v1/safety/matches/${MATCH_ID}/resume`,
        headers: operatorHeaders,
        payload: {
          medicalClearanceConfirmed: true,
          medicalClearanceNote: 'Medical staff cleared this athlete',
        },
      });
      assert.equal(blocked.statusCode, 409, blocked.body);
      const alert = [...f.state.tables.healthAlert.values()][0]!;
      const ack = await app.inject({
        method: 'PATCH',
        url: `/api/v1/safety/alerts/${alert.id}/acknowledge`,
        headers: { ...operatorHeaders, 'idempotency-key': randomUUID() },
        payload: {
          medicalCheckDispatched: true,
          medicalCheckNote: 'Medical check dispatched to court',
        },
      });
      assert.equal(ack.statusCode, 200, ack.body);
      const resume = await app.inject({
        method: 'POST',
        url: `/api/v1/safety/matches/${MATCH_ID}/resume`,
        headers: { ...operatorHeaders, 'idempotency-key': randomUUID() },
        payload: {
          medicalClearanceConfirmed: true,
          medicalClearanceNote: 'Medical staff cleared this athlete',
        },
      });
      assert.equal(resume.statusCode, 200, resume.body);
      assert.equal(f.state.tables.match.get(MATCH_ID)?.status, 'LIVE');
      assert.equal(f.state.tables.securityAuditLog.size, 2);
    } finally {
      await app.close();
    }
  });

  it('rejects foreign match membership/context, and does not invent a pause for standalone critical telemetry', async () => {
    const f = await createSecurityFixture();
    f.state.tables.match.get(MATCH_ID)!.teamA = { members: [] };
    await assert.rejects(
      f.services.safety.processTelemetry({ ...telemetry(), heart_rate: 205, match_id: MATCH_ID }),
      /does not belong/,
    );
    f.state.tables.match.get(MATCH_ID)!.teamA = { members: [{ userId: ATHLETE_ID }] };
    await assert.rejects(
      f.services.safety.processTelemetry({
        ...telemetry(),
        heart_rate: 205,
        match_id: MATCH_ID,
        tournament_id: randomUUID(),
      }),
      /does not belong/,
    );
    const result = await f.services.safety.processTelemetry(
      { ...telemetry(), heart_rate: 205 },
      TelemetrySource.ATHLETE_JWT,
    );
    assert.equal(result.status, 'CRITICAL_ALERT');
    assert.equal(f.state.pauses.length, 1);
    assert.equal([...f.state.tables.healthAlert.values()][0]?.matchPaused, false);
    const outsider = { sub: randomUUID(), role: 'ORGANIZER' };
    await assert.rejects(
      f.services.safety.resume(outsider, MATCH_ID, {
        medicalClearanceConfirmed: true,
        medicalClearanceNote: 'Cleared by medical staff',
      }),
      /owning organizer/,
    );
    assert.equal((await f.services.safety.listAlerts(outsider, { limit: 20 })).data.length, 0);
    await assert.rejects(
      f.services.safety.acknowledge(outsider, [...f.state.tables.healthAlert.values()][0]!.id, {
        medicalCheckNote: 'Medical team dispatched to court',
        medicalCheckDispatched: true,
      }),
      /owning organizer/,
    );
  });

  it('combines measured drill, wearable, and verified wins to cross 85 and dispatch a queued scout alert', async () => {
    const f = await createSecurityFixture();
    await f.services.drills.submitDrill(
      ATHLETE_ID,
      drill(),
      signature('elite'),
      DrillSignatureVersion.FULL,
    );
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let n = 1; n <= 19; n++) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - n);
      const id = randomUUID();
      f.state.tables.wearableSession.set(id, { id, athleteId: ATHLETE_ID, sessionDate: date });
    }
    await f.services.safety.processTelemetry(telemetry());
    assert.equal(f.profile().trainingConsistencyScore, 100);
    const actor = { sub: ORGANIZER_ID, role: 'ORGANIZER' };
    const dto = {
      participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
      winnerAthleteIds: [ATHLETE_ID],
    };
    assert.ok((await f.services.gti.recalculateAthleteGti(ATHLETE_ID)).gti < 85);
    const first = await f.services.results.recordResult(
      TOURNAMENT_ID,
      BRACKET_ID,
      actor,
      { ...dto, matchId: MATCH_ID },
      'first-result-key-0001',
    );
    await f.services.results.recordResult(
      TOURNAMENT_ID,
      BRACKET_ID,
      actor,
      { ...dto, matchId: MATCH_ID },
      'first-result-key-0001',
    );
    assert.equal(f.state.tables.sportPassportRecord.get(ATHLETE_ID)?.totalMatches, 1);
    for (let n = 2; n <= 4; n++)
      await f.services.results.recordResult(
        TOURNAMENT_ID,
        BRACKET_ID,
        actor,
        dto,
        `manual-result-key-${n}`,
      );
    assert.equal(first.matchId, MATCH_ID);
    assert.equal(f.profile().matchPerformanceScore, 100);
    assert.equal(f.state.tables.sportPassportRecord.get(OPPONENT_ID)?.winStreak, 0);
    const result = await f.services.gti.calculateAthleteGti(ATHLETE_ID);
    assert.equal(result.gti, 98.6);
    assert.equal(result.provisional, false);
    assert.deepEqual(result.evidence, {
      biomechanical: 'VERIFIED',
      wearable: 'VERIFIED',
      matchPerformance: 'VERIFIED',
    });
    const history = [...f.state.tables.gtiHistory.values()].at(-1)!;
    assert.deepEqual(history.calculationFactors, {
      w1: 0.35,
      w2: 0.25,
      w3: 0.4,
      calculationVersion: 'gti-v2',
      triggerType: 'MANUAL_RECALCULATION',
      evidence: result.evidence,
      provisional: false,
    });
    assert.equal(result.scoutAlertTriggered, true);
    assert.equal(f.state.tables.scoutAlert.size, 1);
    assert.equal(f.state.scoutJobs.length, 1);
    assert.ok(f.state.jobs.some((job) => job.trigger === 'MATCH_COMPLETED'));
    const processor = new ScoutAlertsProcessor(f.ws, f.prisma);
    await processor.process({ data: f.state.scoutJobs[0] } as Job<ScoutAlertPayload>);
    assert.equal(f.state.scoutEvents.length, 1);
    const again = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(again.scoutAlertTriggered, false);
    assert.equal(f.state.tables.scoutAlert.size, 1);
    f.setProfile({ isScoutSearchable: false });
    assert.equal(
      await processor.process({ data: f.state.scoutJobs[0] } as Job<ScoutAlertPayload>),
      false,
    );
    assert.equal(f.state.scoutEvents.length, 1);
  });

  it('rejects unowned result reporting, foreign participants, paused matches, changed replay payloads, and unassigned umpires', async () => {
    const f = await createSecurityFixture();
    const dto = {
      participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
      winnerAthleteIds: [ATHLETE_ID],
      matchId: MATCH_ID,
    };
    await assert.rejects(
      f.services.results.recordResult(
        TOURNAMENT_ID,
        BRACKET_ID,
        { sub: randomUUID(), role: 'ORGANIZER' },
        dto,
        randomUUID(),
      ),
      /owning organizer/,
    );
    await assert.rejects(
      f.services.results.recordResult(
        TOURNAMENT_ID,
        BRACKET_ID,
        { sub: randomUUID(), role: 'UMPIRE' },
        dto,
        randomUUID(),
      ),
      /assigned umpire/,
    );
    const actor = { sub: UMPIRE_ID, role: 'UMPIRE' };
    await assert.rejects(
      f.services.results.recordResult(
        TOURNAMENT_ID,
        BRACKET_ID,
        actor,
        { ...dto, participantAthleteIds: [ATHLETE_ID, randomUUID()] },
        randomUUID(),
      ),
      /complete match rosters/,
    );
    f.state.tables.match.get(MATCH_ID)!.status = 'PAUSED_SAFETY';
    await assert.rejects(
      f.services.results.recordResult(TOURNAMENT_ID, BRACKET_ID, actor, dto, randomUUID()),
      /unpaused/,
    );
    f.state.tables.match.get(MATCH_ID)!.status = 'LIVE';
    await f.services.results.recordResult(TOURNAMENT_ID, BRACKET_ID, actor, dto, randomUUID());
    await assert.rejects(
      f.services.results.recordResult(
        TOURNAMENT_ID,
        BRACKET_ID,
        actor,
        { ...dto, winnerAthleteIds: [OPPONENT_ID] },
        randomUUID(),
      ),
      /already recorded/,
    );
    assert.equal(f.state.tables.verifiedMatchResult.size, 1);
  });

  it('retries GTI using the latest components and never overwrites a component with a derived snapshot', async () => {
    const f = await createSecurityFixture();
    f.setProfile({
      biomechanicalScore: 80,
      trainingConsistencyScore: 20,
      matchPerformanceScore: 60,
    });
    f.state.failCommit = true;
    f.state.onBegin = (attempt) => {
      if (attempt === 2) f.setProfile({ trainingConsistencyScore: 100, matchPerformanceScore: 90 });
    };
    const result = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(result.gti, 89);
    assert.equal(f.state.tables.gtiHistory.size, 1);
    const writes = f.state.writes.filter((write) => write.model === 'athleteProfile');
    for (const write of writes)
      assert.deepEqual(Object.keys(write.data).sort(), ['currentGti', 'gti']);
    const reads = f.state.reads.filter((read) => read.model === 'athleteProfile');
    assert.ok(reads.filter((read) => read.inTransaction).length >= 2);
    assert.equal(reads.filter((read) => !read.inTransaction).length, 1); // Cache sync reads after commit.
  });

  it('serves ranked state/district leaderboard pages over HTTP and removes obsolete memberships', async () => {
    const f = await createSecurityFixture();
    f.setProfile({ gti: 90, currentGti: new Prisma.Decimal(90), biomechanicalScore: 92 });
    f.setProfile({ gti: 88, currentGti: new Prisma.Decimal(88) }, OPPONENT_ID);
    await f.services.leaderboards.syncAthlete(ATHLETE_ID);
    await f.services.leaderboards.syncAthlete(OPPONENT_ID);
    for (const key of [
      'leaderboard:global:CRICKET',
      'leaderboard:state:Maharashtra:CRICKET',
      'leaderboard:district:Pune:CRICKET',
      'leaderboard:district:Maharashtra:Pune:CRICKET',
    ])
      assert.equal(f.zsets.get(key)?.get(ATHLETE_ID), 90);
    const app = await createSecurityApp(f);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/gti/leaderboards?sport=CRICKET&scope=DISTRICT&state=Maharashtra&district=Pune&limit=1',
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<{
        data: Array<{ rank: number; athleteId: string; biomechanicalScore: number }>;
        nextCursor: string;
        source: string;
      }>();
      assert.equal(body.source, 'redis');
      assert.equal(body.data[0]?.athleteId, ATHLETE_ID);
      assert.equal(body.data[0]?.rank, 1);
      assert.equal(body.data[0]?.biomechanicalScore, 92);
      const next = await app.inject({
        method: 'GET',
        url: `/api/v1/gti/leaderboards?sport=CRICKET&scope=DISTRICT&state=Maharashtra&district=Pune&limit=1&cursor=${body.nextCursor}`,
      });
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(
        next.json<{ data: Array<{ rank: number; athleteId: string }> }>().data[0]?.rank,
        2,
      );
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/gti/leaderboards?sport=CRICKET&scope=DISTRICT&district=Pune',
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/gti/leaderboards?sport=CRICKET&scope=NATIONAL&cursor=${body.nextCursor}`,
          })
        ).statusCode,
        400,
      );
      f.setProfile({ state: 'Karnataka', district: 'Bengaluru', primarySport: 'FOOTBALL' });
      await f.services.leaderboards.syncAthlete(ATHLETE_ID);
      assert.equal(f.zsets.get('leaderboard:district:Pune:CRICKET')?.has(ATHLETE_ID), false);
      assert.equal(f.zsets.get('leaderboard:state:Karnataka:FOOTBALL')?.has(ATHLETE_ID), true);
      f.setProfile({ isScoutSearchable: false });
      await f.services.leaderboards.syncAthlete(ATHLETE_ID);
      assert.equal(f.zsets.get('leaderboard:global:FOOTBALL')?.has(ATHLETE_ID), false);
    } finally {
      await app.close();
    }
  });

  it('groups equally named districts by state and uses current_gti when gti is zero in the fallback', async () => {
    const f = await createSecurityFixture();
    f.setProfile({
      state: 'Maharashtra',
      district: 'Shared',
      gender: 'FEMALE',
      gti: 0,
      currentGti: new Prisma.Decimal(70),
    });
    f.setProfile({ state: 'Karnataka', district: 'Shared', gender: 'MALE', gti: 80 }, OPPONENT_ID);
    const service = new HeatmapsService(
      Object.assign({}, f.prisma, {
        $queryRaw: async () => {
          throw new Error('PostGIS unavailable');
        },
      }) as unknown as PrismaService,
    );
    const rows = (await service.getRegionalHeatmap()).data;
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.state === 'Maharashtra')?.average_gti, 70);
    assert.equal(rows.find((row) => row.state === 'Karnataka')?.average_gti, 80);
  });
  it('keeps composite weights and bounds and recovers scout queue publication on a GTI job retry', async () => {
    const f = await createSecurityFixture();
    assert.equal(f.services.gti.computeCompositeGti(70, 70, 70), 70);
    assert.equal(f.services.gti.computeCompositeGti(200, 200, 200), 100);
    assert.equal(f.services.gti.computeCompositeGti(-50, -50, -50), 0);
    assert.equal(f.services.gti.computeCompositeGti(0, 0, 0), 0);
    f.setProfile({
      biomechanicalScore: 100,
      trainingConsistencyScore: 100,
      matchPerformanceScore: 100,
    });
    const drillId = randomUUID(),
      sessionId = randomUUID(),
      resultId = randomUUID();
    f.state.tables.drillSubmission.set(drillId, { id: drillId, athleteId: ATHLETE_ID });
    f.state.tables.wearableSession.set(sessionId, { id: sessionId, athleteId: ATHLETE_ID });
    f.state.tables.verifiedMatchResult.set(resultId, {
      id: resultId,
      bracketId: BRACKET_ID,
      participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
    });
    const enqueue = f.queue.enqueueScoutAlert.bind(f.queue);
    let fail = true;
    f.queue.enqueueScoutAlert = async (payload) => {
      if (fail) {
        fail = false;
        throw new Error('Queue unavailable');
      }
      return enqueue(payload);
    };
    await assert.rejects(f.services.gti.recalculateAthleteGti(ATHLETE_ID), /Queue unavailable/);
    assert.equal(f.state.tables.scoutAlert.size, 1);
    const retry = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(retry.scoutAlertTriggered, false);
    assert.equal(f.state.scoutJobs.length, 1);
    assert.ok(f.state.scoutJobs[0]?.alertId);
    assert.equal(f.state.tables.scoutAlert.size, 1);
  });

  it('broadcasts an actual safety pause even when post-commit GTI queue publication fails', async () => {
    const f = await createSecurityFixture();
    f.queue.enqueueGtiRecalculation = async () => {
      throw new Error('Queue unavailable');
    };
    await assert.rejects(
      f.services.safety.processTelemetry({ ...telemetry(), heart_rate: 205, match_id: MATCH_ID }),
      /Queue unavailable/,
    );
    assert.equal(f.state.tables.match.get(MATCH_ID)?.status, 'PAUSED_SAFETY');
    assert.equal(f.state.pauses.length, 1);
  });

  it('accepts the verified match HTTP contract and rejects athlete writers and invalid participant lists', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const url = `/api/v1/tournaments/${TOURNAMENT_ID}/brackets/${BRACKET_ID}/matches/record-result`;
    const payload = {
      winnerAthleteIds: [ATHLETE_ID],
      participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
      matchId: MATCH_ID,
    };
    try {
      const denied = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${f.token()}`, 'idempotency-key': randomUUID() },
        payload,
      });
      assert.equal(denied.statusCode, 403);
      const bad = await app.inject({
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
          'idempotency-key': randomUUID(),
        },
        payload: { ...payload, participantAthleteIds: [ATHLETE_ID, ATHLETE_ID] },
      });
      assert.equal(bad.statusCode, 400, bad.body);
      const response = await app.inject({
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
          'idempotency-key': randomUUID(),
        },
        payload,
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(f.state.tables.sportPassportRecord.get(ATHLETE_ID)?.winCount, 1);
      assert.equal(f.profile().matchPerformanceScore, 85);
    } finally {
      await app.close();
    }
  });
  it('marks unsupported component scores provisional and prevents scout outreach until measured evidence exists', async () => {
    const f = await createSecurityFixture();
    f.setProfile({
      biomechanicalScore: 100,
      trainingConsistencyScore: 100,
      matchPerformanceScore: 100,
    });
    const result = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(result.gti, 100);
    assert.equal(result.provisional, true);
    assert.deepEqual(result.evidence, {
      biomechanical: 'NOT_AVAILABLE',
      wearable: 'NOT_AVAILABLE',
      matchPerformance: 'NOT_AVAILABLE',
    });
    assert.equal(result.scoutAlertTriggered, false);
    assert.equal(f.state.scoutJobs.length, 0);
  });
});

describe('Prompt 1 labeled telemetry', () => {
  for (const source of ['BLE', 'SIMULATOR'] as const) {
    it(`requires athlete authentication plus HMAC for ${source}, persists provenance, and emits a critical alert`, async () => {
      const f = await createSecurityFixture();
      const app = await createSecurityApp(f);
      const body = {
        ...telemetry(),
        source,
        heart_rate: 205,
        tournament_id: TOURNAMENT_ID,
        bracket_id: BRACKET_ID,
        ...(source === 'BLE'
          ? { spo2: 98, skin_temperature: 36.8, baseline_fields: ['spo2', 'skin_temperature'] }
          : {}),
      };
      const headers = {
        authorization: `Bearer ${f.token()}`,
        'idempotency-key': randomUUID(),
        'x-device-signature': createHmac('sha256', 'fixture-telemetry-service-secret')
          .update(JSON.stringify(body))
          .digest('hex'),
      };
      try {
        const valid = await app.inject({
          method: 'POST',
          url: '/api/v1/safety/telemetry-webhook',
          headers,
          payload: body,
        });
        assert.equal(valid.statusCode, 200, valid.body);
        assert.equal(f.state.pauses.at(-1)?.source, source);
        assert.equal(f.state.pauses.at(-1)?.tournament_id, TOURNAMENT_ID);
        assert.equal([...f.state.tables.healthAlert.values()][0]?.source, source);
        assert.equal([...f.state.tables.wearableSession.values()][0]?.source, source);
        if (source === 'BLE')
          assert.deepEqual([...f.state.tables.wearableSession.values()][0]?.baselineFields, [
            'spo2',
            'skin_temperature',
          ]);
        const tampered = await app.inject({
          method: 'POST',
          url: '/api/v1/safety/telemetry-webhook',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { ...body, source: source === 'BLE' ? 'SIMULATOR' : 'BLE' },
        });
        assert.equal(tampered.statusCode, 403);
        const unsigned = await app.inject({
          method: 'POST',
          url: '/api/v1/safety/telemetry-webhook',
          headers: { authorization: headers.authorization, 'idempotency-key': randomUUID() },
          payload: body,
        });
        assert.equal(unsigned.statusCode, 403);
      } finally {
        await app.close();
      }
    });
  }
});

it('cannot re-award the same pose digest by changing the signed submission timestamp', async () => {
  const f = await createSecurityFixture();
  const body = drill({
    joint_angles_summary: { client_pose_digest: 'a'.repeat(64), calibrationVersion: '1.0.0' },
  });
  await f.services.drills.submitDrill(
    ATHLETE_ID,
    body,
    '1'.repeat(64),
    DrillSignatureVersion.FULL_V2,
  );
  await assert.rejects(
    f.services.drills.submitDrill(
      ATHLETE_ID,
      { ...body, timestamp: body.timestamp + 1 },
      '2'.repeat(64),
      DrillSignatureVersion.FULL_V2,
    ),
    /already submitted/,
  );
  assert.equal(f.state.tables.drillSubmission.size, 1);
});

describe('Interim Competition GTI weighting while Drills & Wearables are under production', () => {
  it('computes effective GTI from match performance in Interim Competition Mode and breaches 85 Elite Scout threshold', async () => {
    const f = await createSecurityFixture();
    f.setProfile({
      biomechanicalScore: 0,
      trainingConsistencyScore: 0,
      matchPerformanceScore: 90,
    });
    const matchResultId = randomUUID();
    f.state.tables.verifiedMatchResult.set(matchResultId, {
      id: matchResultId,
      bracketId: BRACKET_ID,
      participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
    });

    const result = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(result.gti, 90);
    assert.equal(result.provisional, false);
    assert.deepEqual(result.evidence, {
      biomechanical: 'NOT_AVAILABLE',
      wearable: 'NOT_AVAILABLE',
      matchPerformance: 'VERIFIED',
    });
    assert.equal(result.eliteBreached, true);
    assert.equal(result.scoutAlertTriggered, true);
    assert.equal(f.state.tables.scoutAlert.size, 1);

    const history = [...f.state.tables.gtiHistory.values()].at(-1)!;
    assert.deepEqual(history.calculationFactors, {
      w1: 0,
      w2: 0,
      w3: 1,
      calculationVersion: 'gti-v2',
      triggerType: 'MANUAL_RECALCULATION',
      evidence: result.evidence,
      provisional: false,
    });
  });

  it('normalizes weights across active modules in Partial Telemetry Mode when Drills + Matches are active', async () => {
    const f = await createSecurityFixture();
    f.setProfile({
      biomechanicalScore: 90,
      trainingConsistencyScore: 0,
      matchPerformanceScore: 80,
    });
    const drillId = randomUUID();
    f.state.tables.drillSubmission.set(drillId, { id: drillId, athleteId: ATHLETE_ID });
    const matchResultId = randomUUID();
    f.state.tables.verifiedMatchResult.set(matchResultId, {
      id: matchResultId,
      bracketId: BRACKET_ID,
      participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
    });

    const result = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    // Active weights: w1 = 0.35 / 0.75 = 0.4667, w3 = 0.40 / 0.75 = 0.5333
    // Expected GTI = Math.min(100, 90 * 0.4667 + 0 * 0 + 80 * 0.5333) = 42.003 + 42.664 = 84.67
    assert.equal(result.gti, 84.67);
    assert.equal(result.provisional, false);
    assert.deepEqual(result.evidence, {
      biomechanical: 'VERIFIED',
      wearable: 'NOT_AVAILABLE',
      matchPerformance: 'VERIFIED',
    });
  });

  it('applies standard patent weights in Full-Telemetry Mode when all modules are active', async () => {
    const f = await createSecurityFixture();
    f.setProfile({
      biomechanicalScore: 80,
      trainingConsistencyScore: 80,
      matchPerformanceScore: 80,
    });
    const drillId = randomUUID();
    f.state.tables.drillSubmission.set(drillId, { id: drillId, athleteId: ATHLETE_ID });
    const sessionId = randomUUID();
    f.state.tables.wearableSession.set(sessionId, { id: sessionId, athleteId: ATHLETE_ID });
    const matchResultId = randomUUID();
    f.state.tables.verifiedMatchResult.set(matchResultId, {
      id: matchResultId,
      bracketId: BRACKET_ID,
      participantAthleteIds: [ATHLETE_ID, OPPONENT_ID],
    });

    const result = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(result.gti, 80);
    assert.equal(result.provisional, false);
    assert.deepEqual(result.evidence, {
      biomechanical: 'VERIFIED',
      wearable: 'VERIFIED',
      matchPerformance: 'VERIFIED',
    });
    assert.equal(result.eliteBreached, false);
  });

  it('is completely null-safe when athlete has zero rows across all telemetry and passport records', async () => {
    const f = await createSecurityFixture();
    f.setProfile({
      biomechanicalScore: 0,
      trainingConsistencyScore: 0,
      matchPerformanceScore: 0,
    });
    f.state.tables.drillSubmission.clear();
    f.state.tables.wearableSession.clear();
    f.state.tables.healthAlert.clear();
    f.state.tables.verifiedMatchResult.clear();
    f.state.tables.sportPassportRecord.clear();

    const result = await f.services.gti.recalculateAthleteGti(ATHLETE_ID);
    assert.equal(result.gti, 0);
    assert.equal(result.provisional, true);
    assert.deepEqual(result.evidence, {
      biomechanical: 'NOT_AVAILABLE',
      wearable: 'NOT_AVAILABLE',
      matchPerformance: 'NOT_AVAILABLE',
    });
    assert.equal(result.scoutAlertTriggered, false);
  });
});
