import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { MatchmakingService } from '../src/modules/matchmaking/matchmaking.service';
import { MatchmakingGateway, RosterFormedEventData } from '../src/modules/matchmaking/matchmaking.gateway';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { QueueProducerService } from '../src/infrastructure/queues/queue-producer.service';
import { ConflictException } from '@nestjs/common';
import { FreeAgentStatus, TournamentStatus } from '@prisma/client';

describe('Phase 4: Dynamic Free Agent Matchmaking Pool & Role Balancing Engine', () => {
  const mockGateway = {
    emitRosterFormed: (_data: RosterFormedEventData) => {},
  };

  const mockQueueProducer = {
    enqueueBracketMatchmaking: async () => 'job-123',
  };

  describe('Free Agent Ingestion & Anti-Sandbagging Check', () => {
    it('REJECTS free agent entry with 409 ConflictException when athlete GTI breaches bracket ceiling', async () => {
      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'prof-1',
            currentGti: 82.0, // High GTI
          }),
        },
        bracket: {
          findUnique: async () => ({
            id: 'bracket-open',
            tournamentId: 'tournament-1',
            tierName: 'OPEN_AMATEUR',
            minGti: 0.0,
            maxGti: 50.0, // Ceiling: 50.0
            tournament: {
              id: 'tournament-1',
              status: TournamentStatus.REGISTRATION_OPEN,
              sport: 'CRICKET',
              teamSize: 7,
            },
          }),
        },
      };

      const service = new MatchmakingService(
        mockPrisma as unknown as PrismaService,
        mockQueueProducer as unknown as QueueProducerService,
        mockGateway as unknown as MatchmakingGateway,
      );

      await assert.rejects(
        async () => {
          await service.joinPool(
            'tournament-1',
            'bracket-open',
            'user-athlete-high',
            { primary_role: 'BATSMAN' },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ConflictException);
          const res = err.getResponse() as Record<string, unknown>;
          assert.strictEqual(res['code'], 'SANDBAGGING_DETECTED');
          assert.strictEqual(res['athleteGti'], 82.0);
          assert.strictEqual(res['bracketMaxGti'], 50.0);
          return true;
        },
      );
    });

    it('REJECTS entry when user already has an active queue entry in the tournament', async () => {
      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'prof-2',
            currentGti: 45.0,
          }),
        },
        bracket: {
          findUnique: async () => ({
            id: 'bracket-tier-2',
            tournamentId: 'tournament-1',
            tierName: 'INTERMEDIATE',
            minGti: 30.0,
            maxGti: 60.0,
            tournament: {
              id: 'tournament-1',
              status: TournamentStatus.REGISTRATION_OPEN,
              sport: 'CRICKET',
              teamSize: 7,
            },
          }),
        },
        freeAgentRegistration: {
          findFirst: async () => ({
            id: 'existing-fa-1',
            userId: 'user-athlete-dup',
            status: FreeAgentStatus.QUEUED,
          }),
        },
        teamMember: {
          findFirst: async () => null,
        },
        $transaction: async (
          callback: (transaction: unknown) => Promise<unknown>,
        ) => callback(mockPrisma),
      };

      const service = new MatchmakingService(
        mockPrisma as unknown as PrismaService,
        mockQueueProducer as unknown as QueueProducerService,
        mockGateway as unknown as MatchmakingGateway,
      );

      await assert.rejects(
        async () => {
          await service.joinPool(
            'tournament-1',
            'bracket-tier-2',
            'user-athlete-dup',
            { primary_role: 'BOWLER' },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ConflictException);
          assert.match(err.message, /already queued/);
          return true;
        },
      );
    });

    it('ACCEPTS qualified candidate, persists registration, and triggers BullMQ matchmaking job', async () => {
      let jobDispatched = false;

      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'prof-3',
            currentGti: 45.0,
          }),
        },
        bracket: {
          findUnique: async () => ({
            id: 'bracket-tier-2',
            tournamentId: 'tournament-1',
            tierName: 'INTERMEDIATE',
            minGti: 30.0,
            maxGti: 60.0,
            tournament: {
              id: 'tournament-1',
              status: TournamentStatus.REGISTRATION_OPEN,
              sport: 'CRICKET',
              teamSize: 7,
            },
          }),
        },
        freeAgentRegistration: {
          findFirst: async () => null,
          create: async (payload: { data: { userId: string; tournamentId: string; bracketId: string; sport: string; primaryRole: string; status: FreeAgentStatus } }) => ({
            id: 'new-fa-reg-1',
            ...payload.data,
            secondaryRole: null,
            matchedTeamId: null,
            joinedAt: new Date('2026-10-11T13:40:00Z'),
          }),
          count: async () => 1,
        },
        teamMember: {
          findFirst: async () => null,
        },
        $transaction: async (
          callback: (transaction: unknown) => Promise<unknown>,
        ) => callback(mockPrisma),
      };

      const customQueueProducer = {
        enqueueBracketMatchmaking: async () => {
          jobDispatched = true;
          return 'job-queued-1';
        },
      };

      const service = new MatchmakingService(
        mockPrisma as unknown as PrismaService,
        customQueueProducer as unknown as QueueProducerService,
        mockGateway as unknown as MatchmakingGateway,
      );

      const result = await service.joinPool(
        'tournament-1',
        'bracket-tier-2',
        'user-athlete-valid',
        { primary_role: 'WICKETKEEPER' },
      );

      assert.strictEqual(result.registrationId, 'new-fa-reg-1');
      assert.strictEqual(result.status, FreeAgentStatus.QUEUED);
      assert.strictEqual(result.waitPosition, 1);
      assert.strictEqual(jobDispatched, true);
    });
  });

  describe('The Complementary Role Balancing Algorithm', () => {
    it('successfully matches 7 complementary Cricket specialists into a balanced team within GTI boundaries', async () => {
      let emittedRoster: RosterFormedEventData | null = null;
      const testGateway = {
        emitRosterFormed: (data: RosterFormedEventData) => {
          emittedRoster = data;
        },
      };

      // 7 candidates: 3 Batsmen, 2 Bowlers, 1 All-Rounder, 1 Wicketkeeper
      const sampleCandidates = [
        {
          id: 'fa-1',
          userId: 'user-1',
          primaryRole: 'BATSMAN',
          secondaryRole: null,
          joinedAt: new Date('2026-10-11T13:00:00Z'),
          user: { email: 'bat1@kheleo.com', phone: '+919000000001', athleteProfile: { currentGti: 48.0 } },
        },
        {
          id: 'fa-2',
          userId: 'user-2',
          primaryRole: 'BATSMAN',
          secondaryRole: null,
          joinedAt: new Date('2026-10-11T13:01:00Z'),
          user: { email: 'bat2@kheleo.com', phone: '+919000000002', athleteProfile: { currentGti: 52.0 } },
        },
        {
          id: 'fa-3',
          userId: 'user-3',
          primaryRole: 'BATSMAN',
          secondaryRole: null,
          joinedAt: new Date('2026-10-11T13:02:00Z'),
          user: { email: 'bat3@kheleo.com', phone: '+919000000003', athleteProfile: { currentGti: 46.0 } },
        },
        {
          id: 'fa-4',
          userId: 'user-4',
          primaryRole: 'BOWLER',
          secondaryRole: null,
          joinedAt: new Date('2026-10-11T13:03:00Z'),
          user: { email: 'bowl1@kheleo.com', phone: '+919000000004', athleteProfile: { currentGti: 55.0 } },
        },
        {
          id: 'fa-5',
          userId: 'user-5',
          primaryRole: 'BOWLER',
          secondaryRole: null,
          joinedAt: new Date('2026-10-11T13:04:00Z'),
          user: { email: 'bowl2@kheleo.com', phone: '+919000000005', athleteProfile: { currentGti: 50.0 } },
        },
        {
          id: 'fa-6',
          userId: 'user-6',
          primaryRole: 'ALL_ROUNDER',
          secondaryRole: null,
          joinedAt: new Date('2026-10-11T13:05:00Z'),
          user: { email: 'all1@kheleo.com', phone: '+919000000006', athleteProfile: { currentGti: 54.0 } },
        },
        {
          id: 'fa-7',
          userId: 'user-7',
          primaryRole: 'WICKETKEEPER',
          secondaryRole: null,
          joinedAt: new Date('2026-10-11T13:06:00Z'),
          user: { email: 'wk1@kheleo.com', phone: '+919000000007', athleteProfile: { currentGti: 51.0 } },
        },
      ];

      const mockPrisma = {
        bracket: {
          findUnique: async () => ({
            id: 'bracket-cricket-1',
            tournamentId: 'tournament-1',
            minGti: 40.0,
            maxGti: 65.0,
            entryFee: 0.0,
            tournament: {
              id: 'tournament-1',
              sport: 'CRICKET',
              teamSize: 7,
            },
          }),
        },
        freeAgentRegistration: {
          findMany: async () => sampleCandidates,
        },
        $transaction: async (
          callback: (tx: {
            team: { create: (d: { data: { name: string; tournamentId: string; bracketId: string; isFreeAgentTeam: boolean; isFreeAgentFormed: boolean; averageGti: number } }) => Promise<{ id: string; name: string }> };
            teamMember: { create: (d: unknown) => Promise<unknown> };
            freeAgentRegistration: { updateMany: (d: unknown) => Promise<{ count: number }> };
            registration: {
              count: (d: unknown) => Promise<number>;
              create: (d: unknown) => Promise<unknown>;
            };
          }) => Promise<unknown>,
        ) => {
          return callback({
            team: {
              create: async (d) => ({ id: 'formed-team-1', name: d.data.name }),
            },
            teamMember: { create: async () => ({}) },
            freeAgentRegistration: {
              updateMany: async () => ({ count: 1 }),
            },
            registration: {
              count: async () => 0,
              create: async () => ({}),
            },
          });
        },
      };

      const service = new MatchmakingService(
        mockPrisma as unknown as PrismaService,
        mockQueueProducer as unknown as QueueProducerService,
        testGateway as unknown as MatchmakingGateway,
      );

      const matched = await service.processBracketPool('tournament-1', 'bracket-cricket-1');
      assert.strictEqual(matched, true);
      assert.ok(emittedRoster !== null);
      const rosterEvent = emittedRoster as RosterFormedEventData;
      assert.strictEqual(rosterEvent.team_id, 'formed-team-1');
      assert.match(rosterEvent.team_name, /^FA-Roster-/);
      assert.strictEqual(rosterEvent.roster.length, 7);

      // Verify all positions assigned correctly
      const assignedRoles = rosterEvent.roster.map((m) => m.assigned_role);
      assert.strictEqual(assignedRoles.filter((r) => r === 'BATSMAN').length, 3);
      assert.strictEqual(assignedRoles.filter((r) => r === 'BOWLER').length, 2);
      assert.strictEqual(assignedRoles.filter((r) => r === 'ALL_ROUNDER').length, 1);
      assert.strictEqual(assignedRoles.filter((r) => r === 'WICKETKEEPER').length, 1);
    });

    it('returns false and waits when required specialists are insufficient', async () => {
      // 5 Batsmen, 0 Bowlers, 0 Keepers
      const incompleteCandidates = Array.from({ length: 5 }, (_, i) => ({
        id: `fa-${i}`,
        userId: `user-${i}`,
        primaryRole: 'BATSMAN',
        secondaryRole: null,
        joinedAt: new Date(),
        user: { email: `u${i}@kheleo.com`, phone: null, athleteProfile: { currentGti: 50.0 } },
      }));

      const mockPrisma = {
        bracket: {
          findUnique: async () => ({
            id: 'bracket-cricket-2',
            minGti: 40.0,
            maxGti: 65.0,
            entryFee: 0.0,
            tournament: {
              id: 'tournament-1',
              sport: 'CRICKET',
              teamSize: 7,
            },
          }),
        },
        freeAgentRegistration: {
          findMany: async () => incompleteCandidates,
        },
      };

      const service = new MatchmakingService(
        mockPrisma as unknown as PrismaService,
        mockQueueProducer as unknown as QueueProducerService,
        mockGateway as unknown as MatchmakingGateway,
      );

      const matched = await service.processBracketPool('tournament-1', 'bracket-cricket-2');
      assert.strictEqual(matched, false);
    });
  });
});
