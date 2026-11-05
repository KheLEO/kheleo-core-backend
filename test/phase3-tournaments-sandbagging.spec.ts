import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ConflictException } from '@nestjs/common';
import { Prisma, RegistrationStatus } from '@prisma/client';
import { TournamentsService } from '../src/modules/tournaments/tournaments.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { PostgisSpatialRepository } from '../src/infrastructure/database/postgis-spatial.repository';
import { createCompetitionFixture, TOURNAMENT_ID, BRACKET_ID } from './helpers/competition.fixture';
import { TEST_USER_ID } from './helpers/auth-passport.fixture';

describe('Phase 3: Tournaments Geospatial Discovery & Anti-Sandbagging Engine', () => {
  describe('Transactional Anti-Sandbagging Gatekeeper', () => {
    it('rejects above-ceiling athletes and recommends a bracket containing their actual GTI', async () => {
      const fixture = createCompetitionFixture();
      fixture.state.profiles.get(TEST_USER_ID)!.currentGti = new Prisma.Decimal(75.5);
      const recommended = {
        ...fixture.state.brackets.get(BRACKET_ID)!,
        id: '44444444-4444-4444-8444-444444444444',
        tierName: 'GOLD',
        minGti: new Prisma.Decimal(70),
        maxGti: new Prisma.Decimal(100),
      };
      fixture.state.brackets.set(recommended.id, recommended);
      await assert.rejects(
        fixture.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {}),
        (error: unknown) => {
          assert.ok(error instanceof ConflictException);
          const response = error.getResponse() as Record<string, unknown>;
          assert.strictEqual(response.code, 'SANDBAGGING_DETECTED');
          assert.strictEqual(response.suggestedBracketId, recommended.id);
          assert.strictEqual(response.athleteGti, 75.5);
          return true;
        },
      );
      assert.ok(fixture.state.reads.every((entry) => entry.inTransaction));
    });

    it('rejects athletes below the minimum GTI', async () => {
      const fixture = createCompetitionFixture();
      fixture.state.profiles.get(TEST_USER_ID)!.currentGti = new Prisma.Decimal(25);
      await assert.rejects(
        fixture.services.brackets.registerForBracket(TOURNAMENT_ID, BRACKET_ID, TEST_USER_ID, {}),
        (error: unknown) => {
          assert.ok(error instanceof ConflictException);
          assert.strictEqual(
            (error.getResponse() as Record<string, unknown>).code,
            'BELOW_MINIMUM_TIER',
          );
          return true;
        },
      );
    });

    it('registers an eligible athlete with all eligibility reads and writes in one transaction', async () => {
      const fixture = createCompetitionFixture();
      fixture.state.profiles.get(TEST_USER_ID)!.currentGti = new Prisma.Decimal(52);
      const response = await fixture.services.brackets.registerForBracket(
        TOURNAMENT_ID,
        BRACKET_ID,
        TEST_USER_ID,
        {},
      );
      assert.strictEqual(fixture.state.transactions, 1);
      assert.strictEqual(fixture.state.registrations.has(response.registrationId), true);
      assert.strictEqual(response.athleteGti, 52);
      assert.strictEqual(response.status, RegistrationStatus.CONFIRMED);
      assert.ok(fixture.state.reads.every((entry) => entry.inTransaction));
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
