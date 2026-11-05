import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SecurityAuditLog, Tournament } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { assertTournamentOwner } from './tournament-policy';
import { MatchmakingService } from '../matchmaking/matchmaking.service';

export interface OrganizerSummary {
  activeTournamentsCount: number;
  totalRegisteredAthletes: number;
  totalPrizePoolInr: number;
  freeAgentTeamsFormed: number;
  activeSafetyAlertsCount: number;
}
export interface RosterAthlete {
  userId: string;
  name: string;
  gti: number | null;
  identityStatus: string;
  isActive: boolean;
  role: string;
}
export interface OrganizerRegistration {
  id: string;
  status: string;
  registeredAt: Date;
  teamId: string | null;
  teamName: string | null;
  athletes: RosterAthlete[];
}
export interface OrganizerPoolEntry extends RosterAthlete {
  id: string;
  primaryRole: string;
  secondaryRole: string | null;
  status: string;
  joinedAt: Date;
}
const rosterUserSelect = {
  id: true,
  email: true,
  phone: true,
  isActive: true,
  identityRecord: { select: { status: true } },
  athleteProfile: { select: { currentGti: true } },
} satisfies Prisma.UserSelect;
type RosterUser = Prisma.UserGetPayload<{ select: typeof rosterUserSelect }>;
function athlete(user: RosterUser, role: string): RosterAthlete {
  return {
    userId: user.id,
    name: user.email ?? user.phone ?? user.id,
    gti: user.athleteProfile ? Number(user.athleteProfile.currentGti) : null,
    identityStatus: user.identityRecord?.status ?? 'UNVERIFIED',
    isActive: user.isActive,
    role,
  };
}
@Injectable()
export class OrganizerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matchmaking: MatchmakingService,
  ) {}
  private ownership(actor: AuthenticatedJwtUser): Prisma.TournamentWhereInput {
    if (!['ORGANIZER', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(actor.role))
      throw new ForbiddenException('Organizer access required');
    return actor.role === 'ORGANIZER' ? { organizerId: actor.sub } : {};
  }
  async assertAccess(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
    bracketId?: string,
  ): Promise<void> {
    this.ownership(actor);
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { organizerId: true },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    assertTournamentOwner(tournament.organizerId, actor);
    if (
      bracketId &&
      !(await this.prisma.bracket.findFirst({
        where: { id: bracketId, tournamentId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Bracket does not belong to this tournament');
  }
  async summary(actor: AuthenticatedJwtUser): Promise<OrganizerSummary> {
    const scope = this.ownership(actor);
    const registration = { status: 'CONFIRMED' as const, bracket: { tournament: scope } };
    const [
      activeTournamentsCount,
      totalRegisteredAthletes,
      prizes,
      freeAgentTeamsFormed,
      activeSafetyAlertsCount,
    ] = await Promise.all([
      this.prisma.tournament.count({
        where: { ...scope, status: { in: ['REGISTRATION_OPEN', 'IN_PROGRESS'] } },
      }),
      this.prisma.user.count({
        where: {
          role: 'ATHLETE',
          OR: [
            { registrations: { some: registration } },
            { teamMembers: { some: { team: { registrations: { some: registration } } } } },
            {
              athleteProfile: {
                teamMemberships: { some: { team: { registrations: { some: registration } } } },
              },
            },
          ],
        },
      }),
      this.prisma.tournament.aggregate({
        where: { ...scope, currency: 'INR' },
        _sum: { prizePool: true },
      }),
      this.prisma.team.count({
        where: { tournament: scope, OR: [{ isFreeAgentFormed: true }, { isFreeAgentTeam: true }] },
      }),
      this.prisma.healthAlert.count({
        where: {
          tournament: scope,
          acknowledgedAt: null,
          severity: { in: ['WARNING', 'CRITICAL'] },
        },
      }),
    ]);
    return {
      activeTournamentsCount,
      totalRegisteredAthletes,
      totalPrizePoolInr: Number(prizes._sum.prizePool ?? 0),
      freeAgentTeamsFormed,
      activeSafetyAlertsCount,
    };
  }
  async mine(
    actor: AuthenticatedJwtUser,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<Tournament>> {
    const data = await this.prisma.tournament.findMany({
      where: {
        ...this.ownership(actor),
        ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return PaginatedResponseDto.create(data, query.limit, (row) => row.id);
  }
  async registrations(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
    bracketId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<OrganizerRegistration>> {
    await this.assertAccess(actor, tournamentId, bracketId);
    const rows = await this.prisma.registration.findMany({
      where: { bracketId, ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}) },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      select: {
        id: true,
        status: true,
        registeredAt: true,
        teamId: true,
        user: { select: rosterUserSelect },
        team: {
          select: {
            name: true,
            members: {
              take: 31,
              select: {
                assignedRole: true,
                user: { select: rosterUserSelect },
                athlete: { select: { user: { select: rosterUserSelect } } },
              },
            },
          },
        },
      },
    });
    const data = rows.map((row): OrganizerRegistration => ({
      id: row.id,
      status: row.status,
      registeredAt: row.registeredAt,
      teamId: row.teamId,
      teamName: row.team?.name ?? null,
      athletes: row.team
        ? row.team.members.flatMap((member) => {
            const user = member.user ?? member.athlete?.user;
            return user ? [athlete(user, member.assignedRole)] : [];
          })
        : row.user
          ? [athlete(row.user, 'INDIVIDUAL')]
          : [],
    }));
    return PaginatedResponseDto.create(data, query.limit, (row) => row.id);
  }
  async pool(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
    bracketId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<OrganizerPoolEntry>> {
    await this.assertAccess(actor, tournamentId, bracketId);
    const rows = await this.prisma.freeAgentRegistration.findMany({
      where: {
        tournamentId,
        bracketId,
        status: { in: ['QUEUED', 'MATCHING'] },
        ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      select: {
        id: true,
        primaryRole: true,
        secondaryRole: true,
        status: true,
        joinedAt: true,
        user: { select: rosterUserSelect },
      },
    });
    return PaginatedResponseDto.create(
      rows.map((row): OrganizerPoolEntry => ({
        ...athlete(row.user, row.primaryRole),
        id: row.id,
        primaryRole: row.primaryRole,
        secondaryRole: row.secondaryRole,
        status: row.status,
        joinedAt: row.joinedAt,
      })),
      query.limit,
      (row) => row.id,
    );
  }
  async process(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
    bracketId: string,
  ): Promise<{ formed: boolean }> {
    await this.assertAccess(actor, tournamentId, bracketId);
    return { formed: await this.matchmaking.processBracketPool(tournamentId, bracketId) };
  }
  async sandbaggingLogs(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<SecurityAuditLog>> {
    await this.assertAccess(actor, tournamentId);
    const rows = await this.prisma.securityAuditLog.findMany({
      where: {
        action: 'SANDBAGGING_DETECTED',
        resource: 'tournament',
        resourceId: tournamentId,
        ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return PaginatedResponseDto.create(rows, query.limit, (row) => row.id);
  }
}
