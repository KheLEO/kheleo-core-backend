import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { BracketsService } from '../src/modules/brackets/brackets.service';
import { TournamentsService } from '../src/modules/tournaments/tournaments.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { PostgisSpatialRepository } from '../src/infrastructure/database/postgis-spatial.repository';
import { RegistrationStatus, TournamentStatus } from '@prisma/client';
import { ConflictException } from '@nestjs/common';

describe('Phase 3: Tournaments Geospatial Discovery & Anti-Sandbagging Engine', () => {
  describe('Anti-Sandbagging Gatekeeper Engine', () => {
    it('REJECTS athlete registration with SANDBAGGING_DETECTED when GTI exceeds max_gti ceiling', async () => {
      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'athlete-prof-1',
            currentGti: 75.5, // High skill (75.5)
          }),
        },
        bracket: {
          findUnique: async () => ({
            id: 'bracket-bronze',
            tournamentId: 'tournament-1',
            tierName: 'BRONZE_ENTRY',
            minGti: 0.0,
            maxGti: 40.0, // Ceiling is 40.0
            entryFee: 100.0,
            maxTeams: 16,
            tournament: {
              id: 'tournament-1',
              status: TournamentStatus.REGISTRATION_OPEN,
              title: 'Varanasi Open',
            },
          }),
          findMany: async () => [
            {
              id: 'bracket-gold',
              tierName: 'GOLD_ELITE',
              minGti: 70.0,
              maxGti: 100.0,
            },
          ],
        },
      };

      const bracketsService = new BracketsService(
        mockPrisma as unknown as PrismaService,
      );

      await assert.rejects(
        async () => {
          await bracketsService.registerForBracket(
            'tournament-1',
            'bracket-bronze',
            'user-athlete-1',
            {},
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ConflictException);
          const response = err.getResponse() as Record<string, unknown>;
          assert.strictEqual(response['code'], 'SANDBAGGING_DETECTED');
          assert.strictEqual(response['suggestedBracketId'], 'bracket-gold');
          assert.strictEqual(response['suggestedBracketTier'], 'GOLD_ELITE');
          assert.strictEqual(response['athleteGti'], 75.5);
          assert.strictEqual(response['bracketMaxGti'], 40.0);
          return true;
        },
      );
    });

    it('REJECTS athlete registration with BELOW_MINIMUM_TIER when GTI is below minimum threshold', async () => {
      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'athlete-prof-2',
            currentGti: 25.0, // Low skill (25.0)
          }),
        },
        bracket: {
          findUnique: async () => ({
            id: 'bracket-pro',
            tournamentId: 'tournament-1',
            tierName: 'PRO_DIVISION',
            minGti: 60.0, // Minimum floor is 60.0
            maxGti: 90.0,
            entryFee: 500.0,
            maxTeams: 16,
            tournament: {
              id: 'tournament-1',
              status: TournamentStatus.REGISTRATION_OPEN,
              title: 'Varanasi Open',
            },
          }),
        },
      };

      const bracketsService = new BracketsService(
        mockPrisma as unknown as PrismaService,
      );

      await assert.rejects(
        async () => {
          await bracketsService.registerForBracket(
            'tournament-1',
            'bracket-pro',
            'user-athlete-2',
            {},
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ConflictException);
          const response = err.getResponse() as Record<string, unknown>;
          assert.strictEqual(response['code'], 'BELOW_MINIMUM_TIER');
          assert.strictEqual(response['athleteGti'], 25.0);
          assert.strictEqual(response['bracketMinGti'], 60.0);
          return true;
        },
      );
    });

    it('ACCEPTS qualifying athlete within GTI limits and wraps creation in transaction', async () => {
      let transactionExecuted = false;

      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'athlete-prof-3',
            currentGti: 52.0, // Within range [40.0, 65.0]
          }),
        },
        bracket: {
          findUnique: async () => ({
            id: 'bracket-silver',
            tournamentId: 'tournament-1',
            tierName: 'SILVER_INTERMEDIATE',
            minGti: 40.0,
            maxGti: 65.0,
            entryFee: 250.0,
            maxTeams: 16,
            tournament: {
              id: 'tournament-1',
              status: TournamentStatus.REGISTRATION_OPEN,
              title: 'Varanasi Open',
            },
          }),
        },
        $transaction: async (
          callback: (tx: {
            registration: {
              findUnique: () => Promise<null>;
              count: () => Promise<number>;
              create: (data: {
                data: {
                  bracketId: string;
                  userId: string;
                  feePaid: number;
                  status: RegistrationStatus;
                };
              }) => Promise<{
                id: string;
                bracketId: string;
                userId: string;
                teamId: null;
                status: RegistrationStatus;
                feePaid: number;
                registeredAt: Date;
              }>;
            };
          }) => Promise<unknown>,
        ) => {
          transactionExecuted = true;
          return callback({
            registration: {
              findUnique: async () => null,
              count: async () => 8, // 8 / 16 registered
              create: async (payload) => ({
                id: 'reg-new-1',
                bracketId: payload.data.bracketId,
                userId: payload.data.userId,
                teamId: null,
                status: payload.data.status,
                feePaid: payload.data.feePaid,
                registeredAt: new Date('2026-10-11T13:00:00Z'),
              }),
            },
          });
        },
      };

      const bracketsService = new BracketsService(
        mockPrisma as unknown as PrismaService,
      );

      const result = await bracketsService.registerForBracket(
        'tournament-1',
        'bracket-silver',
        'user-athlete-3',
        {},
      );

      assert.strictEqual(transactionExecuted, true);
      assert.strictEqual(result.registrationId, 'reg-new-1');
      assert.strictEqual(result.tierName, 'SILVER_INTERMEDIATE');
      assert.strictEqual(result.athleteGti, 52.0);
      assert.strictEqual(result.status, RegistrationStatus.CONFIRMED);
      assert.strictEqual(result.feePaid, 250.0);
    });
  });

  describe('Geospatial Tournament Discovery', () => {
    it('returns flat TournamentLocationDto structures stripped of relational overhead', async () => {
      const mockSpatialRepo = {
        findTournamentsWithinRadius: async () => [
          {
            id: 'tour-1',
            name: 'Kashi Cup',
            title: 'Kashi Cup',
            sport: 'CRICKET',
            status: 'REGISTRATION_OPEN',
            min_gti: 20.0,
            max_gti: 60.0,
            venue_name: 'Sampurnanand Ground',
            venue_lat: 25.32,
            venue_lng: 82.98,
            prize_pool: 20000,
            distance_km: 4.23,
            registration_deadline: new Date('2026-10-25T18:00:00Z'),
            start_date: new Date('2026-11-01T09:00:00Z'),
            team_size: 11,
            max_teams: 16,
          },
        ],
      };

      const mockPrisma = {};

      const service = new TournamentsService(
        mockPrisma as unknown as PrismaService,
        mockSpatialRepo as unknown as PostgisSpatialRepository,
      );

      const nearby = await service.findNearby({
        lat: 25.3176,
        lng: 82.9739,
        radius_km: 25,
        limit: 10,
      });

      assert.strictEqual(nearby.length, 1);
      const first = nearby[0];
      assert.strictEqual(first?.id, 'tour-1');
      assert.strictEqual(first?.name, 'Kashi Cup');
      assert.strictEqual(first?.distanceKm, 4.2);
      assert.strictEqual(first?.sport, 'CRICKET');
      // Verify no heavy nested relations attached
      const firstRecord = first as unknown as Record<string, unknown>;
      assert.strictEqual(firstRecord['brackets'], undefined);
      assert.strictEqual(firstRecord['teams'], undefined);
    });
  });
});
