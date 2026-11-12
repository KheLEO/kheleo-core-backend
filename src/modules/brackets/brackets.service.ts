import { recordSandbaggingRejection } from '../tournaments/sandbagging-audit';
import { competitionConfig } from '../tournaments/competition-config';
import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { bumpVersion, CACHE_KEYS } from '../../infrastructure/cache/cache-helper';
import { RegisterBracketDto } from './dto/register-bracket.dto';
import { CreateBracketDto } from './dto/create-bracket.dto';
import { UpdateBracketDto } from './dto/update-bracket.dto';
import { BracketRegistrationResponseDto } from './dto/bracket-registration-response.dto';
import { Bracket, Prisma, Registration, RegistrationStatus, Tournament } from '@prisma/client';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { assertBracketInvariants, assertTournamentOwner } from '../tournaments/tournament-policy';
import {
  assertCompleteVerifiedProfile,
  assertScoreFitsBracket,
  ParticipationBracket,
  ParticipationProfile,
  participationProfileSelect,
  readParticipationSnapshot,
} from '../tournaments/participation-policy';

@Injectable()
export class BracketsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async registerForBracket(
    tournamentId: string,
    bracketId: string,
    userId: string,
    dto: RegisterBracketDto,
  ): Promise<BracketRegistrationResponseDto> {
    const outcome = await runSerializableTransaction(this.prisma, async (transaction) => {
      const { profile, bracket, athleteGti } = await readParticipationSnapshot(
        transaction,
        tournamentId,
        bracketId,
        userId,
      );
      const teamGti = dto.teamId
        ? await this.validateTeam(transaction, dto.teamId, userId, profile, bracket)
        : undefined;
      const existing = dto.teamId
        ? await transaction.registration.findFirst({ where: { bracketId, teamId: dto.teamId } })
        : await transaction.registration.findUnique({
            where: { bracketId_userId: { bracketId, userId } },
          });
      if (existing?.status === RegistrationStatus.CONFIRMED) {
        return {
          createdOrUpdated: false,
          organizerId: bracket.tournament?.organizerId,
          response: this.mapToResponse(existing, tournamentId, profile.id, bracket.tierName, athleteGti),
        };
      }
      const count = await transaction.registration.count({
        where: { bracketId, status: RegistrationStatus.CONFIRMED },
      });
      if (count >= bracket.maxTeams)
        throw new ConflictException(
          'Registration closed: This tournament bracket has reached maximum capacity.',
        );
      const data = {
        bracketId,
        userId,
        teamId: dto.teamId ?? null,
        status: RegistrationStatus.CONFIRMED,
        feePaid: 0,
        metadata: {
          verifiedGtiAtRegistration: athleteGti,
          ...(teamGti !== undefined ? { teamGti } : {}),
          tierName: bracket.tierName,
          gatekeeperStatus: 'PASSED',
          registeredAt: new Date().toISOString(),
        },
      };
      const registration = existing
        ? await transaction.registration.update({ where: { id: existing.id }, data })
        : await transaction.registration.create({ data });
      return {
        createdOrUpdated: true,
        organizerId: bracket.tournament?.organizerId,
        response: this.mapToResponse(
          registration,
          tournamentId,
          profile.id,
          bracket.tierName,
          athleteGti,
        ),
      };
    }).catch(async (error: unknown) => {
      await recordSandbaggingRejection(this.prisma, error, tournamentId, bracketId, userId);
      throw error;
    });
    if (outcome.createdOrUpdated) {
      if (outcome.organizerId) {
        await bumpVersion(this.redis, CACHE_KEYS.organizerVersion(outcome.organizerId));
      }
      await bumpVersion(this.redis, CACHE_KEYS.organizerVersion('GLOBAL'));
    }
    return outcome.response;
  }

  private async validateTeam(
    transaction: Prisma.TransactionClient,
    teamId: string,
    userId: string,
    caller: ParticipationProfile,
    bracket: ParticipationBracket,
  ): Promise<number> {
    const team = await transaction.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        tournamentId: true,
        bracketId: true,
        captainId: true,
        members: {
          take: 31,
          select: {
            userId: true,
            athleteId: true,
            isCaptain: true,
            user: { select: { athleteProfile: { select: participationProfileSelect } } },
            athlete: { select: participationProfileSelect },
          },
        },
      },
    });
    if (!team || team.tournamentId !== bracket.tournamentId)
      throw new BadRequestException('Team does not belong to this tournament');
    const captain =
      team.captainId === userId ||
      team.members.some(
        (member) =>
          member.isCaptain && (member.userId === userId || member.athleteId === caller.id),
      );
    if (!captain) throw new ForbiddenException('Only the team captain may register this team');
    if (team.bracketId && team.bracketId !== bracket.id)
      throw new ConflictException('Team is already assigned to another bracket');
    if (team.members.length !== bracket.tournament.teamSize)
      throw new BadRequestException('Team roster must match the tournament teamSize');
    const profiles = team.members.map((member) => {
      const profile = member.user?.athleteProfile ?? member.athlete;
      assertCompleteVerifiedProfile(profile);
      return profile;
    });
    if (new Set(profiles.map((profile) => profile.userId)).size !== profiles.length)
      throw new BadRequestException('Team roster contains duplicate athletes');
    const meanGti = profiles
      .reduce((sum, profile) => sum.add(profile.currentGti), new Prisma.Decimal(0))
      .div(profiles.length)
      .toNumber();
    await assertScoreFitsBracket(transaction, bracket, meanGti, 'Team');
    await transaction.team.update({
      where: { id: team.id },
      data: { bracketId: bracket.id, averageGti: meanGti, compositeGti: meanGti },
    });
    return meanGti;
  }

  async findByTournament(
    tournamentId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<Bracket>> {
    const limit = query.limit ?? 20;
    const brackets = await this.prisma.bracket.findMany({
      where: { tournamentId, ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}) },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return PaginatedResponseDto.create(brackets, limit, (bracket) => bracket.id);
  }

  async createBracket(
    tournamentId: string,
    dto: CreateBracketDto,
    actor: AuthenticatedJwtUser,
  ): Promise<Bracket> {
    return runSerializableTransaction(this.prisma, async (transaction) => {
      const tournament = await this.assertOwnership(transaction, tournamentId, actor);
      assertBracketInvariants({
        minGti: dto.minGti,
        maxGti: dto.maxGti,
        entryFee: dto.entryFee ?? 0,
        maxTeams: dto.maxTeams ?? 16,
      });
      return transaction.bracket.create({
        data: {
          tournamentId,
          config: competitionConfig(dto.config, tournament.teamSize, Number(tournament.prizePool)),
          name: dto.name,
          tierName: dto.tierName,
          minGti: dto.minGti,
          maxGti: dto.maxGti,
          entryFee: dto.entryFee ?? 0,
          maxTeams: dto.maxTeams ?? 16,
          bracketType: dto.bracketType,
        },
      });
    });
  }

  async updateBracket(
    tournamentId: string,
    bracketId: string,
    dto: UpdateBracketDto,
    actor: AuthenticatedJwtUser,
  ): Promise<Bracket> {
    return runSerializableTransaction(this.prisma, async (transaction) => {
      await this.assertOwnership(transaction, tournamentId, actor);
      const existing = await transaction.bracket.findUnique({ where: { id: bracketId } });
      if (!existing || existing.tournamentId !== tournamentId)
        throw new NotFoundException('Bracket does not exist in this tournament');
      const tournament = await transaction.tournament.findUnique({ where: { id: tournamentId } });
      if (!tournament) throw new NotFoundException('Tournament not found');
      const data = {
        config: competitionConfig(
          dto.config ?? existing.config,
          tournament.teamSize,
          Number(tournament.prizePool),
        ),
        name: dto.name ?? existing.name,
        tierName: dto.tierName ?? existing.tierName,
        minGti: dto.minGti ?? Number(existing.minGti),
        maxGti: dto.maxGti ?? Number(existing.maxGti),
        entryFee: dto.entryFee ?? Number(existing.entryFee),
        maxTeams: dto.maxTeams ?? existing.maxTeams,
        bracketType: dto.bracketType ?? existing.bracketType,
      };
      assertBracketInvariants(data);
      return transaction.bracket.update({ where: { id: bracketId }, data });
    });
  }

  async deleteBracket(
    tournamentId: string,
    bracketId: string,
    actor: AuthenticatedJwtUser,
  ): Promise<Bracket> {
    return runSerializableTransaction(this.prisma, async (transaction) => {
      await this.assertOwnership(transaction, tournamentId, actor);
      const bracket = await transaction.bracket.findUnique({ where: { id: bracketId } });
      if (!bracket || bracket.tournamentId !== tournamentId)
        throw new NotFoundException('Bracket does not exist in this tournament');
      return transaction.bracket.delete({ where: { id: bracketId } });
    });
  }

  private async assertOwnership(
    transaction: Prisma.TransactionClient,
    tournamentId: string,
    actor: AuthenticatedJwtUser,
  ): Promise<Pick<Tournament, 'organizerId' | 'teamSize' | 'prizePool'>> {
    const tournament = await transaction.tournament.findUnique({
      where: { id: tournamentId },
      select: { organizerId: true, teamSize: true, prizePool: true },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    assertTournamentOwner(tournament.organizerId, actor);
    return tournament;
  }

  private mapToResponse(
    reg: Registration,
    tournamentId: string,
    athleteId: string,
    tierName: string,
    athleteGti: number,
  ): BracketRegistrationResponseDto {
    return {
      registrationId: reg.id,
      bracketId: reg.bracketId,
      tournamentId,
      athleteId,
      tierName,
      athleteGti,
      status: reg.status,
      feePaid: Number(reg.feePaid),
      registeredAt: reg.registeredAt.toISOString(),
      teamId: reg.teamId,
    };
  }
}
