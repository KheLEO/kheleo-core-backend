import 'reflect-metadata';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrganizerService } from '../src/modules/tournaments/organizer.service';
import {
  createSecurityFixture,
  createSecurityApp,
  ORGANIZER_ID,
  ATHLETE_ID,
  OPPONENT_ID,
  SCOUT_ID,
  SUPER_ID,
  MATCH_ID,
} from './helpers/security-gti.fixture';
import {
  createCompetitionFixture,
  TOURNAMENT_ID,
  BRACKET_ID,
  makeProfile,
} from './helpers/competition.fixture';
import { createSocketFixture, deadline } from './helpers/socket.fixture';
const actor = { sub: ORGANIZER_ID, role: 'ORGANIZER' };
const clearance = {
  medicalClearanceConfirmed: true,
  medicalClearanceNote: 'Medical team confirms clearance',
};

describe('Prompt 2 organizer contracts and authorization', () => {
  it('returns owned KPI values, excludes another organizer, and admits administrators', async () => {
    const f = await createSecurityFixture();
    f.state.tables.tournament.get(TOURNAMENT_ID)!.prizePool = new Prisma.Decimal(25000);
    f.state.tables.tournament.set('33333333-3333-4333-8333-333333333333', {
      ...f.state.tables.tournament.get(TOURNAMENT_ID)!,
      id: '33333333-3333-4333-8333-333333333333',
      organizerId: SCOUT_ID,
      prizePool: new Prisma.Decimal(90000),
    });
    f.state.tables.user.get(SCOUT_ID)!.role = 'ORGANIZER';
    const owned = await f.services.organizer.summary(actor);
    assert.equal(owned.activeTournamentsCount, 1);
    assert.equal(owned.totalPrizePoolInr, 25000);
    assert.equal(owned.totalRegisteredAthletes, 2);
    const all = await f.services.organizer.summary({ sub: SUPER_ID, role: 'SUPER_ADMIN' });
    assert.equal(all.activeTournamentsCount, 2);
    assert.equal(all.totalPrizePoolInr, 115000);
    const app = await createSecurityApp(f);
    try {
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/tournaments/organizer/summary',
            headers: { authorization: `Bearer ${f.token()}` },
          })
        ).statusCode,
        403,
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tournaments/organizer/summary',
        headers: { authorization: `Bearer ${f.token(ORGANIZER_ID)}` },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<{ totalPrizePoolInr: number }>().totalPrizePoolInr, 25000);
    } finally {
      await app.close();
    }
  });
  it('paginates owned events with stable UUID cursors', async () => {
    const f = await createSecurityFixture();
    const secondId = '33333333-3333-4333-8333-333333333333';
    f.state.tables.tournament.set(secondId, {
      ...f.state.tables.tournament.get(TOURNAMENT_ID)!,
      id: secondId,
    });
    const first = await f.services.organizer.mine(actor, { limit: 1 });
    assert.equal(first.data.length, 1);
    assert.equal(first.has_more, true);
    const second = await f.services.organizer.mine(actor, {
      limit: 1,
      cursor_id: first.next_cursor!,
    });
    assert.equal(second.data[0]?.id, secondId);
    assert.equal(second.has_more, false);
  });
  it('returns verified individual registrations and denies foreign bracket/tournament access before invoking a matchmaker', async () => {
    const f = await createSecurityFixture();
    const data = await f.services.organizer.registrations(actor, TOURNAMENT_ID, BRACKET_ID, {
      limit: 20,
    });
    assert.equal(data.data.length, 2);
    assert.equal(data.data[0]?.athletes[0]?.identityStatus, 'VERIFIED');
    await assert.rejects(
      f.services.organizer.registrations(
        { sub: SCOUT_ID, role: 'ORGANIZER' },
        TOURNAMENT_ID,
        BRACKET_ID,
        { limit: 20 },
      ),
      ForbiddenException,
    );
    await assert.rejects(f.services.organizer.process(actor, TOURNAMENT_ID, randomUUID()));
    assert.equal(f.state.matchmakerCalls.length, 0);
    const result = await f.services.organizer.process(actor, TOURNAMENT_ID, BRACKET_ID);
    assert.equal(result.formed, true);
    assert.equal(f.state.matchmakerCalls.length, 1);
  });
  it('stores custom quotas and prizes and uses bracket quotas ahead of sport defaults', async () => {
    const f = createCompetitionFixture();
    const owner = {
      sub: String(f.state.tournaments.get(TOURNAMENT_ID)!.organizerId),
      role: 'ORGANIZER',
    };
    const event = f.state.tournaments.get(TOURNAMENT_ID)!;
    event.teamSize = 2;
    event.prizePool = new Prisma.Decimal(1000);
    const bracket = f.state.brackets.get(BRACKET_ID)!;
    bracket.maxGti = new Prisma.Decimal(100);
    await f.services.brackets.updateBracket(
      TOURNAMENT_ID,
      BRACKET_ID,
      {
        config: {
          roleQuotas: { BOWLER: 2 },
          prizeBreakdown: { first: 500, second: 200, third: 100 },
        },
      },
      owner,
    );
    assert.deepEqual(f.state.brackets.get(BRACKET_ID)?.config, {
      roleQuotas: { BOWLER: 2 },
      prizeBreakdown: { first: 500, second: 200, third: 100 },
    });
    for (let index = 0; index < 2; index++) {
      const id = randomUUID();
      f.state.profiles.set(id, makeProfile(id, 50));
      await f.services.matchmaking.joinPool(TOURNAMENT_ID, BRACKET_ID, id, {
        primary_role: 'BOWLER',
      });
    }
    assert.equal(await f.services.matchmaking.processBracketPool(TOURNAMENT_ID, BRACKET_ID), true);
    assert.equal(f.state.teams.size, 1);
    assert.equal(f.state.members.size, 2);
    await assert.rejects(
      f.services.brackets.updateBracket(
        TOURNAMENT_ID,
        BRACKET_ID,
        { config: { roleQuotas: { BOWLER: 3 } } },
        owner,
      ),
      /quota total/,
    );
    await assert.rejects(
      f.services.brackets.updateBracket(
        TOURNAMENT_ID,
        BRACKET_ID,
        { config: { prizeBreakdown: { first: 1001, second: 0, third: 0 } } },
        owner,
      ),
      /exceeds/,
    );
  });
  it('persists rejected sandbagging attempts outside transaction rollback', async () => {
    const f = createCompetitionFixture();
    const userId = [...f.state.profiles.keys()][0]!;
    f.state.profiles.get(userId)!.currentGti = new Prisma.Decimal(99);
    await assert.rejects(
      f.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, userId, {}),
      ConflictException,
    );
    const log = f.auth.state.auditLogs.find((entry) => entry.action === 'SANDBAGGING_DETECTED');
    assert.ok(log);
    assert.equal(log.resourceId, TOURNAMENT_ID);
    assert.equal(f.state.registrations.size, 0);
  });
  it('records named match results, scores and win/loss counters once across an idempotent retry', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const key = randomUUID();
    const body = {
      matchName: 'Campus semi-final',
      winnerAthleteIds: [ATHLETE_ID],
      loserAthleteIds: [OPPONENT_ID],
      scoreSummary: { score: '2-1' },
      matchId: MATCH_ID,
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await app.inject({
          method: 'POST',
          url: `/api/v1/tournaments/${TOURNAMENT_ID}/brackets/${BRACKET_ID}/matches/results`,
          headers: { authorization: `Bearer ${f.token(ORGANIZER_ID)}`, 'idempotency-key': key },
          payload: body,
        });
        assert.equal(result.statusCode, 201, result.body);
      }
      assert.equal(f.state.tables.verifiedMatchResult.size, 1);
      assert.equal([...f.state.tables.verifiedMatchResult.values()][0]?.matchName, body.matchName);
      assert.equal(f.state.tables.sportPassportRecord.get(ATHLETE_ID)?.winCount, 1);
      assert.equal(f.profile().matchPerformanceScore, 85);
      assert.ok(f.state.jobs.some((job) => job.trigger === 'MATCH_COMPLETED'));
      const invalid = await app.inject({
        method: 'POST',
        url: `/api/v1/tournaments/${TOURNAMENT_ID}/brackets/${BRACKET_ID}/matches/results`,
        headers: {
          authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
          'idempotency-key': randomUUID(),
        },
        payload: { ...body, loserAthleteIds: [ATHLETE_ID] },
      });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

describe('Prompt 2 confidential safety operations', () => {
  it('guards medical snapshot/history HTTP reads and rejects missing dispatch or clearance confirmation', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    f.state.tables.user.get(SCOUT_ID)!.role = 'ORGANIZER';
    try {
      for (const resource of ['vitals', 'alerts']) {
        const url = `/api/v1/safety/tournaments/${TOURNAMENT_ID}/${resource}`;
        for (const [userId, expected] of [
          [ORGANIZER_ID, 200],
          [SCOUT_ID, 403],
          [ATHLETE_ID, 403],
        ] as const) {
          const response = await app.inject({
            method: 'GET',
            url,
            headers: { authorization: `Bearer ${f.token(userId)}` },
          });
          assert.equal(response.statusCode, expected, response.body);
        }
      }
      await f.services.safety.processTelemetry({
        athlete_id: ATHLETE_ID,
        match_id: MATCH_ID,
        heart_rate: 205,
        spo2: 98,
        skin_temperature: 36.8,
        timestamp: Date.now(),
      });
      const alertId = [...f.state.tables.healthAlert.keys()][0]!;
      const ack = await app.inject({
        method: 'PATCH',
        url: `/api/v1/safety/alerts/${alertId}/acknowledge`,
        headers: {
          authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
          'idempotency-key': randomUUID(),
        },
        payload: {},
      });
      assert.equal(ack.statusCode, 400, ack.body);
      assert.equal(f.state.tables.healthAlert.get(alertId)?.acknowledgedAt, null);
      const resume = await app.inject({
        method: 'POST',
        url: `/api/v1/safety/matches/${MATCH_ID}/resume`,
        headers: {
          authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
          'idempotency-key': randomUUID(),
        },
        payload: { medicalClearanceNote: 'Medical team attending' },
      });
      assert.equal(resume.statusCode, 400, resume.body);
      assert.equal(f.state.tables.match.get(MATCH_ID)?.status, 'PAUSED_SAFETY');
    } finally {
      await app.close();
    }
  });
  it('persists latest normal/critical vitals, coalesces open incidents, and requires medical clearance', async () => {
    const f = await createSecurityFixture();
    const now = Date.now();
    const reading = {
      athlete_id: ATHLETE_ID,
      tournament_id: TOURNAMENT_ID,
      bracket_id: BRACKET_ID,
      match_id: MATCH_ID,
      heart_rate: 110,
      spo2: 98,
      skin_temperature: 36.8,
      timestamp: now,
    };
    await f.services.safety.processTelemetry(reading);
    assert.equal(f.state.tables.tournamentVital.size, 1);
    await f.services.safety.processTelemetry({ ...reading, heart_rate: 205, timestamp: now + 1 });
    await f.services.safety.processTelemetry({ ...reading, heart_rate: 206, timestamp: now + 2 });
    assert.equal(f.state.tables.healthAlert.size, 1);
    const wall = await f.services.safety.tournamentVitals(actor, TOURNAMENT_ID, { limit: 20 });
    assert.equal(wall.data.find((entry) => entry.athleteId === ATHLETE_ID)?.severity, 'CRITICAL');
    assert.equal(wall.matches[0]?.status, 'PAUSED_SAFETY');
    await assert.rejects(
      f.services.safety.tournamentVitals({ sub: SCOUT_ID, role: 'ORGANIZER' }, TOURNAMENT_ID, {
        limit: 20,
      }),
      ForbiddenException,
    );
    await assert.rejects(f.services.safety.resume(actor, MATCH_ID, clearance), /Acknowledge/);
    const alertId = [...f.state.tables.healthAlert.keys()][0]!;
    await assert.rejects(
      f.services.safety.acknowledge(actor, alertId, {
        medicalCheckNote: '     ',
        medicalCheckDispatched: true,
      }),
      /medical check/,
    );
    await assert.rejects(
      f.services.safety.acknowledge(actor, alertId, {
        medicalCheckNote: 'Staff attending',
        medicalCheckDispatched: false,
      }),
      /medical check/,
    );
    await f.services.safety.acknowledge(actor, alertId, {
      medicalCheckNote: 'Medical team dispatched to court',
      medicalCheckDispatched: true,
    });
    await assert.rejects(f.services.safety.resume(actor, MATCH_ID), /clearance/);
    assert.equal((await f.services.safety.resume(actor, MATCH_ID, clearance)).status, 'LIVE');
    assert.equal(
      f.state.tables.healthAlert.get(alertId)?.medicalCheckNote,
      'Medical team dispatched to court',
    );
    await assert.rejects(
      f.services.safety.processTelemetry({ ...reading, timestamp: now - 1 }),
      /older/,
    );
  });
  it('delivers VITALS_UPDATED only to authorized staff scopes, including after restart-style resubscription', async () => {
    const f = await createSecurityFixture();
    const sockets = await createSocketFixture(f);
    try {
      const owner = sockets.client('/ws/events', f.token(ORGANIZER_ID));
      const athlete = sockets.client('/ws/events', f.token());
      f.state.tables.user.get(SCOUT_ID)!.role = 'ORGANIZER';
      const stranger = sockets.client('/ws/events', f.token(SCOUT_ID));
      await Promise.all([
        sockets.connect(owner),
        sockets.connect(athlete),
        sockets.connect(stranger),
      ]);
      await sockets.events.handleJoinTournament(sockets.serverSocket(owner), {
        tournamentId: TOURNAMENT_ID,
      });
      await sockets.events.handleJoinTournament(sockets.serverSocket(athlete), {
        tournamentId: TOURNAMENT_ID,
      });
      let leaks = 0;
      athlete.on('VITALS_UPDATED', () => {
        leaks++;
      });
      stranger.on('VITALS_UPDATED', () => {
        leaks++;
      });
      const received = deadline(
        new Promise<void>((resolve) => owner.once('VITALS_UPDATED', () => resolve())),
      );
      sockets.events.broadcastVitalsUpdated({
        tournament_id: TOURNAMENT_ID,
        athlete_id: ATHLETE_ID,
        heart_rate: 110,
        spo2: 98,
        skin_temperature: 36.8,
        severity: 'NORMAL',
        observed_at: new Date().toISOString(),
        source: 'BLE',
        baseline_fields: [],
      });
      await received;
      const barrier = deadline(
        new Promise<void>((resolve) => athlete.once('barrier', () => resolve())),
      );
      sockets.serverSocket(athlete).emit('barrier');
      await barrier;
      assert.equal(leaks, 0);
      assert.ok(sockets.serverSocket(owner).rooms.has(`safety:tournament:${TOURNAMENT_ID}`));
      assert.equal(
        sockets.serverSocket(athlete).rooms.has(`safety:tournament:${TOURNAMENT_ID}`),
        false,
      );
    } finally {
      await sockets.close();
    }
  });
});
