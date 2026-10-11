import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RegisterBracketDto } from './dto/register-bracket.dto';
import { CreateBracketDto } from './dto/create-bracket.dto';
import { BracketRegistrationResponseDto } from './dto/bracket-registration-response.dto';
import { Bracket, Registration, RegistrationStatus, TournamentStatus } from '@prisma/client';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';

@Injectable()
export class BracketsService {
  private readonly logger = new Logger(BracketsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The Anti-Sandbagging Gatekeeper Engine:
   * 1. Retrieves athlete's verified Grassroots Talent Index (GTI).
   * 2. Evaluates against Bracket's max_gti ceiling.
   * 3. Rejects with 409 ConflictException & SANDBAGGING_DETECTED error code if athlete GTI exceeds ceiling.
   * 4. Enforces concurrency safety via strict Prisma $transaction.
   */
  async registerForBracket(
    tournamentId: string,
    bracketId: string,
    userId: string,
    dto: RegisterBracketDto,
  ): Promise<BracketRegistrationResponseDto> {
    // 1. Retrieve athlete's verified profile & GTI
    const athleteProfile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      select: { id: true, currentGti: true },
    });

    if (!athleteProfile) {
      throw new BadRequestException(
        'Athlete profile must be initialized and verified before tournament registration.',
      );
    }

    const athleteGti = Number(athleteProfile.currentGti);

    // 2. Retrieve bracket and verify tournament affiliation
    const bracket = await this.prisma.bracket.findUnique({
      where: { id: bracketId },
      select: {
        id: true,
        tournamentId: true,
        tierName: true,
        minGti: true,
        maxGti: true,
        maxTeams: true,
        entryFee: true,
        tournament: {
          select: { status: true },
        },
      },
    });

    if (!bracket || bracket.tournamentId !== tournamentId) {
      throw new NotFoundException(
        `Bracket with ID ${bracketId} does not exist in tournament ${tournamentId}.`,
      );
    }

    if (bracket.tournament.status !== TournamentStatus.REGISTRATION_OPEN) {
      throw new BadRequestException('Tournament is not currently open for registration.');
    }

    const maxGti = Number(bracket.maxGti);
    const minGti = Number(bracket.minGti);

    // 3. Gatekeeper Evaluation: Anti-Sandbagging Anti-Smurf Check
    if (athleteGti > maxGti) {
      this.logger.warn(
        `Anti-Sandbagging Gatekeeper Flag: Athlete ${userId} (GTI: ${athleteGti}) attempted registration in Bracket ${bracket.tierName} (Max: ${maxGti})`,
      );

      // Search for suggested higher-tier bracket in the tournament
      const higherBrackets = await this.prisma.bracket.findMany({
        where: {
          tournamentId,
          id: { not: bracketId },
          maxGti: { gte: athleteProfile.currentGti },
        },
        orderBy: { minGti: 'asc' },
        take: 1,
        select: { id: true, tierName: true },
      });

      const suggestedBracket = higherBrackets[0] ?? null;

      throw new ConflictException({
        code: 'SANDBAGGING_DETECTED',
        error: 'Conflict',
        message: `Athlete verified GTI (${athleteGti.toFixed(2)}) exceeds bracket maximum allowable ceiling (${maxGti.toFixed(2)}). Anti-sandbagging rules prohibit over-qualified players from competing in this tier.`,
        athleteGti,
        bracketMaxGti: maxGti,
        bracketMinGti: minGti,
        suggestedBracketId: suggestedBracket?.id ?? null,
        suggestedBracketTier: suggestedBracket?.tierName ?? null,
      });
    }

    if (athleteGti < minGti) {
      throw new ConflictException({
        code: 'BELOW_MINIMUM_TIER',
        error: 'Conflict',
        message: `Athlete verified GTI (${athleteGti.toFixed(2)}) does not meet the minimum floor threshold (${minGti.toFixed(2)}) for this tier.`,
        athleteGti,
        bracketMinGti: minGti,
        bracketMaxGti: maxGti,
      });
    }

    // 4. Strict atomic transaction for registration insert & capacity verification
    return runSerializableTransaction(this.prisma, async (tx) => {
      // Check if athlete is already registered in this bracket
      const existing = await tx.registration.findUnique({
        where: {
          bracketId_userId: { bracketId, userId },
        },
      });

      if (existing && existing.status === RegistrationStatus.CONFIRMED) {
        return this.mapToResponse(
          existing,
          tournamentId,
          athleteProfile.id,
          bracket.tierName,
          athleteGti,
        );
      }

      // Check current capacity under isolation
      const currentConfirmed = await tx.registration.count({
        where: { bracketId, status: RegistrationStatus.CONFIRMED },
      });

      if (currentConfirmed >= bracket.maxTeams) {
        throw new ConflictException(
          'Registration closed: This tournament bracket has reached maximum capacity.',
        );
      }

      const registration = await tx.registration.create({
        data: {
          bracketId,
          userId,
          teamId: dto.teamId ?? null,
          status: RegistrationStatus.CONFIRMED,
          feePaid: bracket.entryFee,
          metadata: {
            verifiedGtiAtRegistration: athleteGti,
            tierName: bracket.tierName,
            gatekeeperStatus: 'PASSED',
            registeredAt: new Date().toISOString(),
          },
        },
      });

      return this.mapToResponse(
        registration,
        tournamentId,
        athleteProfile.id,
        bracket.tierName,
        athleteGti,
      );
    });
  }

  /**
   * Retrieves all brackets for a tournament.
   */
  async findByTournament(
    tournamentId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<Bracket>> {
    const limit = query.limit;
    const brackets = await this.prisma.bracket.findMany({
      where: { tournamentId },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(query.cursor_id ? { cursor: { id: query.cursor_id }, skip: 1 } : {}),
    });
    return PaginatedResponseDto.create(brackets, limit, (bracket) => bracket.id);
  }

  /**
   * Creates a new bracket in a tournament.
   */
  async createBracket(tournamentId: string, dto: CreateBracketDto): Promise<Bracket> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) {
      throw new NotFoundException(`Tournament with ID ${tournamentId} not found.`);
    }

    return this.prisma.bracket.create({
      data: {
        tournamentId,
        name: dto.name,
        tierName: dto.tierName,
        minGti: dto.minGti,
        maxGti: dto.maxGti,
        entryFee: dto.entryFee ?? 0,
        maxTeams: dto.maxTeams ?? 16,
        bracketType: dto.bracketType,
      },
    });
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
