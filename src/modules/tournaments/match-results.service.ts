import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { MatchStatus, Prisma, VerifiedMatchResult } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import {
  hasTransactionalOutboxTriggers,
  notifyOutboxSubscribers,
} from '../../infrastructure/outbox/outbox-authority';
import { CACHE_KEYS, invalidateCacheKeys } from '../../infrastructure/cache/cache-helper';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import {
  assertMatchOperator,
  matchContextSelect,
  matchParticipants,
  teamParticipants,
} from '../../common/competition/match-access';
import { assertAccountAccess } from '../../common/auth/account-access';
import { canonicalJson } from '../../common/crypto/canonical-json';
import { RecordMatchResultDto } from './dto/record-match-result.dto';

@Injectable()
export class MatchResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueProducerService,
    @Optional() private readonly redis?: RedisService,
  ) {}
  async recordResult(
    tournamentId: string,
    bracketId: string,
    actor: AuthenticatedJwtUser,
    dto: RecordMatchResultDto,
    idempotencyKey: string,
  ): Promise<VerifiedMatchResult> {
    if (!idempotencyKey || idempotencyKey.length < 16)
      throw new BadRequestException('Idempotency-Key must be at least 16 characters');
    const participants = [...new Set(dto.participantAthleteIds)].sort();
    const winners = [...new Set(dto.winnerAthleteIds)].sort();
    if (
      participants.length < 2 ||
      winners.length === 0 ||
      winners.length >= participants.length ||
      winners.some((id) => !participants.includes(id))
    )
      throw new BadRequestException('Winners must be a nonempty proper subset of participants');
    const fingerprint = createHash('sha256')
      .update(
        canonicalJson({
          tournamentId,
          bracketId,
          participants,
          winners,
          matchId: dto.matchId ?? null,
          matchName: dto.matchName ?? '',
          scoreSummary: dto.scoreSummary ?? {},
        }),
      )
      .digest('hex');
    const requestKey = createHash('sha256')
      .update(`${actor.sub}:${bracketId}:${idempotencyKey}`)
      .digest('hex');
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const bracket = await tx.bracket.findUnique({
        where: { id: bracketId },
        include: { tournament: true },
      });
      if (!bracket || bracket.tournamentId !== tournamentId)
        throw new NotFoundException('Tournament bracket not found');
      const match = dto.matchId
        ? await tx.match.findUnique({ where: { id: dto.matchId }, select: matchContextSelect })
        : undefined;
      if (dto.matchId && (!match || match.bracketId !== bracketId))
        throw new BadRequestException('Match does not belong to this bracket');
      assertMatchOperator(actor, bracket.tournament.organizerId, match ?? undefined);
      const existing = await tx.verifiedMatchResult.findFirst({
        where: { OR: [{ requestKey }, ...(dto.matchId ? [{ matchId: dto.matchId }] : [])] },
      });
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ConflictException(
            'Result already recorded with different participants or winners',
          );
        return existing;
      }
      if (bracket.tournament.status !== 'IN_PROGRESS')
        throw new ConflictException('Results require a tournament in progress');
      if (match) {
        if (!(['LIVE', 'WARMUP'] as readonly MatchStatus[]).includes(match.status))
          throw new ConflictException('Only an active, unpaused match can be completed');
        const roster = matchParticipants(match).sort();
        const teamA = teamParticipants(match.teamA.members).sort();
        const teamB = teamParticipants(match.teamB.members).sort();
        if (
          canonicalJson(roster) !== canonicalJson(participants) ||
          ![teamA, teamB].some((team) => canonicalJson(team) === canonicalJson(winners))
        )
          throw new BadRequestException(
            'Participants and winners must match the complete match rosters',
          );
        await tx.match.update({
          where: { id: match.id },
          data: {
            status: 'COMPLETED',
            winnerTeamId:
              canonicalJson(teamA) === canonicalJson(winners) ? match.teamAId : match.teamBId,
            scoreSummary: {
              ...dto.scoreSummary,
              matchName: dto.matchName ?? '',
              participantAthleteIds: participants,
              winnerAthleteIds: winners,
            } as Prisma.InputJsonObject,
          },
        });
      } else {
        const confirmedRegs = await tx.registration.findMany({
          where: {
            bracketId,
            status: 'CONFIRMED',
            OR: [
              { userId: { in: participants } },
              {
                team: {
                  members: {
                    some: {
                      OR: [{ userId: { in: participants } }, { athlete: { userId: { in: participants } } }],
                    },
                  },
                },
              },
            ],
          },
          select: {
            userId: true,
            team: {
              select: {
                members: {
                  select: { userId: true, athlete: { select: { userId: true } } },
                },
              },
            },
          },
        });
        const confirmedUsers = new Set<string>();
        for (const reg of confirmedRegs) {
          if (reg.userId) confirmedUsers.add(reg.userId);
          for (const member of reg.team?.members ?? []) {
            if (member.userId) confirmedUsers.add(member.userId);
            if (member.athlete?.userId) confirmedUsers.add(member.athlete.userId);
          }
        }
        for (const userId of participants) {
          if (!confirmedUsers.has(userId)) {
            throw new BadRequestException('Every participant must be confirmed in this bracket');
          }
        }
      }

      const sortedParticipants = [...participants].sort();
      const profiles = await tx.athleteProfile.findMany({
        where: { userId: { in: sortedParticipants } },
        include: { user: { include: { identityRecord: true } } },
      });
      const profileByUserId = new Map(profiles.map((p) => [p.userId, p]));
      for (const userId of sortedParticipants) {
        const profile = profileByUserId.get(userId);
        if (!profile || profile.user.role !== 'ATHLETE') {
          throw new BadRequestException('Participant profile not found');
        }
        assertAccountAccess(profile.user);
      }

      const sportRecords = await tx.sportPassportRecord.findMany({
        where: {
          athleteId: { in: profiles.map((p) => p.id) },
          sport: bracket.tournament.sport,
        },
      });
      const recordByAthleteId = new Map(sportRecords.map((r) => [r.athleteId, r]));
      const updates: Array<Promise<unknown>> = [];
      for (const userId of sortedParticipants) {
        const profile = profileByUserId.get(userId)!;
        const record = recordByAthleteId.get(profile.id);
        if (!record) throw new BadRequestException('Participant sport record not found');
        const won = winners.includes(userId);
        const totalMatches = record.totalMatches + 1;
        const winCount = record.winCount + Number(won);
        const winStreak = won ? record.winStreak + 1 : 0;
        updates.push(
          tx.sportPassportRecord.update({
            where: { id: record.id },
            data: { totalMatches, winCount, winStreak },
          }),
        );
        const score = Number(
          (
            (Math.min(100, (winCount / totalMatches) * 80 + Math.min(winStreak, 4) * 5) *
              Number(bracket.maxGti)) /
            100
          ).toFixed(2),
        );
        if (profile.primarySport === bracket.tournament.sport) {
          updates.push(
            tx.athleteProfile.update({
              where: { id: profile.id },
              data: { matchPerformanceScore: score, matchPerfScore: new Prisma.Decimal(score) },
            }),
          );
        }
      }
      await Promise.all(updates);
      return tx.verifiedMatchResult.create({
        data: {
          bracketId,
          matchName: dto.matchName ?? '',
          scoreSummary: (dto.scoreSummary ?? {}) as Prisma.InputJsonObject,
          matchId: dto.matchId,
          reportedById: actor.sub,
          requestKey,
          fingerprint,
          participantAthleteIds: participants,
          winnerAthleteIds: winners,
        },
      });
    });
    await invalidateCacheKeys(
      this.redis,
      result.participantAthleteIds.map((athleteId) => CACHE_KEYS.passport(athleteId)),
    );
    if (!hasTransactionalOutboxTriggers(this.prisma)) {
      await Promise.all(
        result.participantAthleteIds.map((athleteId) =>
          this.queue.enqueueGtiRecalculation({ athleteId, trigger: 'MATCH_COMPLETED' }),
        ),
      );
    } else {
      notifyOutboxSubscribers(this.redis, 'GTI');
    }
    return result;
  }
}
