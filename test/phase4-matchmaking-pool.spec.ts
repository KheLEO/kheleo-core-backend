import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { FreeAgentStatus, Prisma } from '@prisma/client';
import { MatchmakingService } from '../src/modules/matchmaking/matchmaking.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { QueueProducerService } from '../src/infrastructure/queues/queue-producer.service';
import { MatchmakingGateway } from '../src/modules/matchmaking/matchmaking.gateway';
import { RoleSlotRequirement } from '../src/modules/matchmaking/role-matcher';
import { createCompetitionFixture, BRACKET_ID, TOURNAMENT_ID } from './helpers/competition.fixture';
import { TEST_USER_ID } from './helpers/auth-passport.fixture';

const cricketSlots: readonly RoleSlotRequirement[] = [
  { slotName: 'BATSMAN', rolePattern: /BAT/i },
  { slotName: 'BOWLER', rolePattern: /BOWL/i },
  { slotName: 'ALL_ROUNDER', rolePattern: /ALL|ROUND/i },
  { slotName: 'WICKETKEEPER', rolePattern: /KEEP|WICKET/i },
];

describe('Phase 4: Transactional free-agent pool and exact role matching', () => {
  it('rejects above-ceiling joins and includes an accurate bracket suggestion', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.profiles.get(TEST_USER_ID)!.currentGti = new Prisma.Decimal(82);
    const suggestion = {
      ...fixture.state.brackets.get(BRACKET_ID)!,
      id: '44444444-4444-4444-8444-444444444444',
      minGti: new Prisma.Decimal(70),
      maxGti: new Prisma.Decimal(100),
      tierName: 'GOLD',
    };
    fixture.state.brackets.set(suggestion.id, suggestion);
    await assert.rejects(
      fixture.services.matchmaking.joinPool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
        primary_role: 'BATSMAN',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        const response = error.getResponse() as Record<string, unknown>;
        assert.equal(response.code, 'SANDBAGGING_DETECTED');
        assert.equal(response.suggestedBracketId, suggestion.id);
        assert.equal(response.suggestedBracketTier, 'GOLD');
        return true;
      },
    );
    assert.ok(fixture.state.reads.every((entry) => entry.inTransaction));
  });

  it('rejects duplicate queue entries in the same tournament', async () => {
    const fixture = createCompetitionFixture();
    await fixture.services.matchmaking.joinPool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
      primary_role: 'BATSMAN',
    });
    await assert.rejects(
      fixture.services.matchmaking.joinPool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
        primary_role: 'BATSMAN',
      }),
      /already queued/,
    );
    assert.equal(fixture.state.agents.size, 1);
    assert.equal(fixture.state.enqueued, 1);
  });

  it('persists eligible joins before dispatching matchmaking and reports queue position', async () => {
    const fixture = createCompetitionFixture();
    const result = await fixture.services.matchmaking.joinPool(
      TOURNAMENT_ID,
      BRACKET_ID,
      TEST_USER_ID,
      { primary_role: 'WICKETKEEPER' },
    );
    assert.equal(result.status, FreeAgentStatus.QUEUED);
    assert.equal(result.waitPosition, 1);
    assert.equal(fixture.state.agents.has(result.registrationId), true);
    assert.equal(fixture.state.enqueued, 1);
    assert.equal(fixture.state.transactions, 1);
  });

  it('matches seven Cricket specialists and assigns the captain consistently on team and membership', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.tournaments.get(TOURNAMENT_ID)!.teamSize = 7;
    for (const role of [
      'BATSMAN',
      'BATSMAN',
      'BATSMAN',
      'BOWLER',
      'BOWLER',
      'ALL_ROUNDER',
      'WICKETKEEPER',
    ])
      fixture.addCandidate(role);
    assert.equal(
      await fixture.services.matchmaking.processBracketPool(TOURNAMENT_ID, BRACKET_ID),
      true,
    );
    assert.equal(fixture.state.teams.size, 1);
    const team = [...fixture.state.teams.values()][0]!;
    const captain = [...fixture.state.members.values()].filter((member) => member.isCaptain);
    assert.equal(captain.length, 1);
    assert.equal(captain[0]?.userId, team.captainId);
    const roles = fixture.state.events[0]!.roster.map((member) => member.assigned_role);
    assert.equal(roles.filter((role) => role === 'BATSMAN').length, 3);
    assert.equal(roles.filter((role) => role === 'BOWLER').length, 2);
    assert.equal(roles.filter((role) => role === 'ALL_ROUNDER').length, 1);
    assert.equal(roles.filter((role) => role === 'WICKETKEEPER').length, 1);
    assert.ok(
      [...fixture.state.agents.values()].every((agent) => agent.status === FreeAgentStatus.MATCHED),
    );
  });

  it('tests genuine role shortage with a valid tournamentId and more than enough queued candidates', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.tournaments.get(TOURNAMENT_ID)!.teamSize = 7;
    for (let index = 0; index < 8; index += 1) fixture.addCandidate('BATSMAN');
    assert.equal(fixture.state.brackets.get(BRACKET_ID)?.tournamentId, TOURNAMENT_ID);
    assert.equal(
      await fixture.services.matchmaking.processBracketPool(TOURNAMENT_ID, BRACKET_ID),
      false,
    );
    assert.ok(fixture.state.reads.some((entry) => entry.model === 'agent'));
    assert.equal(fixture.state.teams.size, 0);
    assert.equal(fixture.state.events.length, 0);
  });

  it('solves the exact four-player dual-role counterexample from audit Probe 4', () => {
    const fixture = createCompetitionFixture();
    const candidates = [
      { primaryRole: 'BATSMAN', secondaryRole: 'BOWLER' },
      { primaryRole: 'BATSMAN', secondaryRole: null },
      { primaryRole: 'ALL_ROUNDER', secondaryRole: null },
      { primaryRole: 'WICKETKEEPER', secondaryRole: null },
    ];
    const assigned = fixture.services.matchmaking.matchCandidatesToSlots(candidates, cricketSlots);
    assert.ok(assigned);
    assert.equal(assigned.length, 4);
    assert.equal(new Set(assigned.map((item) => item.candidate)).size, 4);
    assert.equal(assigned.find((item) => item.slotName === 'BOWLER')?.candidate, candidates[0]);
    assert.equal(assigned.find((item) => item.slotName === 'BATSMAN')?.candidate, candidates[1]);
  });

  it('searches alternative rosters when the first role-valid roster violates mean GTI', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.brackets.get(BRACKET_ID)!.minGti = new Prisma.Decimal(49);
    fixture.state.brackets.get(BRACKET_ID)!.maxGti = new Prisma.Decimal(51);
    const high = fixture.addCandidate('BATSMAN', null, 100);
    fixture.addCandidate('BATSMAN', null, 50);
    for (const role of ['BOWLER', 'ALL_ROUNDER', 'WICKETKEEPER'])
      fixture.addCandidate(role, null, 50);
    assert.equal(
      await fixture.services.matchmaking.processBracketPool(TOURNAMENT_ID, BRACKET_ID),
      true,
    );
    assert.equal(fixture.state.agents.get(high.id)?.status, FreeAgentStatus.QUEUED);
    assert.equal([...fixture.state.teams.values()][0]?.averageGti, 50);
  });

  it('checks mean GTI before rounding rather than admitting a slightly out-of-tier team', async () => {
    const fixture = createCompetitionFixture();
    fixture.addCandidate('BATSMAN', null, 65.01);
    for (const role of ['BOWLER', 'ALL_ROUNDER', 'WICKETKEEPER'])
      fixture.addCandidate(role, null, 65);
    assert.equal(
      await fixture.services.matchmaking.processBracketPool(TOURNAMENT_ID, BRACKET_ID),
      false,
    );
    assert.equal(fixture.state.teams.size, 0);
  });

  it('forms every available valid team during a single worker invocation', async () => {
    const fixture = createCompetitionFixture();
    for (let index = 0; index < 2; index += 1)
      for (const role of ['BATSMAN', 'BOWLER', 'ALL_ROUNDER', 'WICKETKEEPER'])
        fixture.addCandidate(role);
    assert.equal(
      await fixture.services.matchmaking.processBracketPool(TOURNAMENT_ID, BRACKET_ID),
      true,
    );
    assert.equal(fixture.state.teams.size, 2);
    assert.equal(fixture.state.events.length, 2);
    assert.equal(fixture.state.registrations.size, 2);
    assert.equal(
      new Set([...fixture.state.members.values()].map((member) => member.userId)).size,
      8,
    );
  });

  it('finds specialists beyond the first 200 FIFO candidates', async () => {
    const fixture = createCompetitionFixture();
    for (let index = 0; index < 201; index += 1) fixture.addCandidate('BATSMAN');
    for (const role of ['BOWLER', 'ALL_ROUNDER', 'WICKETKEEPER']) fixture.addCandidate(role);
    assert.equal(
      await fixture.services.matchmaking.processBracketPool(TOURNAMENT_ID, BRACKET_ID),
      true,
    );
    assert.equal(fixture.state.events[0]?.roster.length, 4);
    assert.ok(fixture.state.reads.filter((entry) => entry.model === 'agent').length >= 3);
  });

  it('re-reads GTI after a serializable retry and does not enqueue a newly ineligible athlete', async () => {
    const fixture = createCompetitionFixture();
    fixture.state.failNextCommit = true;
    fixture.state.onBegin = (attempt) => {
      if (attempt === 2)
        fixture.state.profiles.get(TEST_USER_ID)!.currentGti = new Prisma.Decimal(90);
    };
    await assert.rejects(
      fixture.services.matchmaking.joinPool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {
        primary_role: 'BATSMAN',
      }),
      ConflictException,
    );
    assert.equal(fixture.state.transactions, 2);
    assert.equal(fixture.state.agents.size, 0);
    assert.equal(fixture.state.enqueued, 0);
    assert.equal(fixture.state.reads.filter((entry) => entry.model === 'profile').length, 2);
  });

  it('simulates a worker claim between the leave read and conditional update without clobbering MATCHED', async () => {
    const state: { status: FreeAgentStatus; inTransaction: boolean } = {
      status: FreeAgentStatus.QUEUED,
      inTransaction: false,
    };
    const prisma = {
      freeAgentRegistration: {
        findFirst: async (): Promise<{ readonly id: string }> => {
          assert.equal(state.inTransaction, true);
          state.status = FreeAgentStatus.MATCHED;
          return { id: 'queued-registration' };
        },
        updateMany: async ({
          where,
          data,
        }: {
          readonly where: { readonly userId: string; readonly status: FreeAgentStatus };
          readonly data: { readonly status: FreeAgentStatus };
        }): Promise<{ readonly count: number }> => {
          assert.equal(where.userId, TEST_USER_ID);
          assert.equal(where.status, FreeAgentStatus.QUEUED);
          if (state.status !== where.status) return { count: 0 };
          state.status = data.status;
          return { count: 1 };
        },
      },
      $transaction: async (
        operation: (transaction: unknown) => Promise<unknown>,
      ): Promise<unknown> => {
        state.inTransaction = true;
        try {
          return await operation(prisma);
        } finally {
          state.inTransaction = false;
        }
      },
    };
    const service = new MatchmakingService(
      prisma as unknown as PrismaService,
      {} as QueueProducerService,
      {} as MatchmakingGateway,
    );
    await assert.rejects(
      service.leavePool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID),
      /Cannot leave pool: registration is already matched or cancelled/,
    );
    assert.equal(state.status, FreeAgentStatus.MATCHED);
  });

  it('cancels only a queued registration and rejects a second leave', async () => {
    const fixture = createCompetitionFixture();
    const queued = await fixture.services.matchmaking.joinPool(
      TOURNAMENT_ID,
      BRACKET_ID,
      TEST_USER_ID,
      { primary_role: 'BATSMAN' },
    );
    assert.equal(
      (await fixture.services.matchmaking.leavePool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID))
        .cancelled,
      true,
    );
    assert.equal(
      fixture.state.agents.get(queued.registrationId)?.status,
      FreeAgentStatus.CANCELLED,
    );
    await assert.rejects(
      fixture.services.matchmaking.leavePool(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID),
      ConflictException,
    );
  });
});

describe('Role solver completeness', () => {
  it('agrees with exhaustive enumeration across 500 deterministic role/GTI/identity cases', () => {
    const fixture = createCompetitionFixture();
    const randomState = { seed: 9173 };
    const random = (limit: number): number => {
      randomState.seed = (Math.imul(randomState.seed, 1664525) + 1013904223) >>> 0;
      return randomState.seed % limit;
    };
    interface Candidate {
      readonly primaryRole: string;
      readonly secondaryRole: string | null;
      readonly gti: number;
      readonly user: string;
    }
    for (let example = 0; example < 500; example += 1) {
      const candidates: Candidate[] = Array.from({ length: 5 }, (_unused, index) => ({
        primaryRole: ['A', 'B', 'C'][random(3)]!,
        secondaryRole: random(2) === 0 ? null : ['A', 'B', 'C'][random(3)]!,
        gti: 20 + random(61),
        user: `user-${index === 4 && random(2) === 0 ? 0 : index}`,
      }));
      const slots: RoleSlotRequirement[] = Array.from({ length: 3 }, (_unused, index) => ({
        slotName: `slot-${index}`,
        rolePattern: new RegExp(['A', 'B', 'C'][random(3)]!),
      }));
      const used = new Set<string>();
      const bruteForce = (slot: number, total: number): boolean => {
        if (slot === slots.length) return total / slots.length >= 40 && total / slots.length <= 60;
        for (const candidate of candidates) {
          if (
            used.has(candidate.user) ||
            (!slots[slot]!.rolePattern.test(candidate.primaryRole) &&
              !(candidate.secondaryRole && slots[slot]!.rolePattern.test(candidate.secondaryRole)))
          )
            continue;
          used.add(candidate.user);
          if (bruteForce(slot + 1, total + candidate.gti)) return true;
          used.delete(candidate.user);
        }
        return false;
      };
      const expected = bruteForce(0, 0);
      const actual = fixture.services.matchmaking.matchCandidatesToSlots(candidates, slots, {
        minGti: 40,
        maxGti: 60,
        score: (candidate) => candidate.gti,
        identity: (candidate) => candidate.user,
      });
      assert.equal(
        actual !== null,
        expected,
        `Example ${example}: ${JSON.stringify({ candidates, slots: slots.map((slot) => slot.rolePattern.source) })}`,
      );
      if (actual) {
        assert.equal(new Set(actual.map((item) => item.candidate.user)).size, slots.length);
        const mean = actual.reduce((sum, item) => sum + item.candidate.gti, 0) / slots.length;
        assert.ok(mean >= 40 && mean <= 60);
      }
    }
  });
});
