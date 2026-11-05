import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MatchStatus, Prisma, VerifiedMatchResult } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import {
  assertMatchOperator,
  matchContextSelect,
  matchParticipants,
  teamParticipants,
} from '../../common/competition/match-access';
import { assertVerifiedAthlete } from '../../common/auth/account-access';
import { canonicalJson } from '../../common/crypto/canonical-json';
import { RecordMatchResultDto } from './dto/record-match-result.dto';

@Injectable()
export class MatchResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueProducerService,
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
            scoreSummary: { participantAthleteIds: participants, winnerAthleteIds: winners },
          },
        });
      } else {
        for (const userId of participants) {
          const registration = await tx.registration.findFirst({
            where: {
              bracketId,
              status: 'CONFIRMED',
              OR: [
                { userId },
                { team: { members: { some: { OR: [{ userId }, { athlete: { userId } }] } } } },
              ],
            },
            select: { id: true },
          });
          if (!registration)
            throw new BadRequestException('Every participant must be confirmed in this bracket');
        }
      }
      for (const userId of participants) {
        const profile = await tx.athleteProfile.findUnique({
          where: { userId },
          include: { user: { include: { identityRecord: true } } },
        });
        if (!profile || profile.user.role !== 'ATHLETE')
          throw new BadRequestException('Participant profile not found');
        assertVerifiedAthlete(profile.user);
        const record = await tx.sportPassportRecord.findUnique({
          where: { athleteId_sport: { athleteId: profile.id, sport: bracket.tournament.sport } },
        });
        if (!record) throw new BadRequestException('Participant sport record not found');
        const won = winners.includes(userId);
        const totalMatches = record.totalMatches + 1;
        const winCount = record.winCount + Number(won);
        const winStreak = won ? record.winStreak + 1 : 0;
        await tx.sportPassportRecord.update({
          where: { id: record.id },
          data: { totalMatches, winCount, winStreak },
        });
        const score = Number(
          (
            (Math.min(100, (winCount / totalMatches) * 80 + Math.min(winStreak, 4) * 5) *
              Number(bracket.maxGti)) /
            100
          ).toFixed(2),
        );
        if (profile.primarySport === bracket.tournament.sport)
          await tx.athleteProfile.update({
            where: { id: profile.id },
            data: { matchPerformanceScore: score, matchPerfScore: new Prisma.Decimal(score) },
          });
      }
      return tx.verifiedMatchResult.create({
        data: {
          bracketId,
          matchId: dto.matchId,
          reportedById: actor.sub,
          requestKey,
          fingerprint,
          participantAthleteIds: participants,
          winnerAthleteIds: winners,
        },
      });
    });
    await Promise.all(
      result.participantAthleteIds.map((athleteId) =>
        this.queue.enqueueGtiRecalculation({ athleteId, trigger: 'MATCH_COMPLETED' }),
      ),
    );
    return result;
  }
}
