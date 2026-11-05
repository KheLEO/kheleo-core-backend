import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SecurityAuditLog, Tournament, TournamentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { HealthService, HealthResponse } from '../health/health.service';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { LeaderboardsService } from '../leaderboards/leaderboards.service';
import { WsAuthGuard } from '../../infrastructure/realtime/ws-auth.guard';
import {
  AdminAuditQuery,
  AdminTournamentStatusDto,
  AdminTournamentsQuery,
  AdminUsersQuery,
  AdminUserStatusDto,
  ModerationAction,
} from './admin.dto';

import { CursorPage } from '../../common/dto/cursor-page';

const adminUserSelect = {
  id: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  createdAt: true,
  identityRecord: { select: { status: true, reLinkedCount: true, verifiedAt: true } },
} as const;
export type AdminUserResponse = Prisma.UserGetPayload<{ select: typeof adminUserSelect }>;
export interface AdminDashboardResponse {
  readonly verifiedAthletes: number;
  readonly activeTournaments: number;
  readonly organizers: number;
  readonly scouts: number;
  readonly verifiedDrills: number;
  readonly criticalMatchPauses: number;
  readonly health: HealthResponse;
}
function page<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
  return {
    data: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  };
}
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
    private readonly leaderboards: LeaderboardsService,
    private readonly sockets: WsAuthGuard,
  ) {}
  async dashboard(): Promise<AdminDashboardResponse> {
    const [
      verifiedAthletes,
      activeTournaments,
      organizers,
      scouts,
      verifiedDrills,
      criticalMatchPauses,
      health,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { role: 'ATHLETE', isActive: true, identityRecord: { status: 'VERIFIED' } },
      }),
      this.prisma.tournament.count({
        where: { status: { in: ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'IN_PROGRESS'] } },
      }),
      this.prisma.user.count({ where: { role: 'ORGANIZER', isActive: true } }),
      this.prisma.user.count({ where: { role: 'SCOUT', isActive: true } }),
      this.prisma.drillSubmission.count({ where: { metadataVerified: true } }),
      this.prisma.healthAlert.count({
        where: { severity: 'CRITICAL', matchPaused: true, matchId: { not: null } },
      }),
      this.health.check(),
    ]);
    return {
      verifiedAthletes,
      activeTournaments,
      organizers,
      scouts,
      verifiedDrills,
      criticalMatchPauses,
      health,
    };
  }
  async users(query: AdminUsersQuery): Promise<CursorPage<AdminUserResponse>> {
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query.role ? { role: query.role } : {}),
        ...(query.verificationStatus
          ? { identityRecord: { status: query.verificationStatus } }
          : {}),
      },
      select: adminUserSelect,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    return page(rows, query.limit);
  }
  async updateUser(
    actor: AuthenticatedJwtUser,
    id: string,
    dto: AdminUserStatusDto,
  ): Promise<AdminUserResponse> {
    if (
      dto.role === undefined &&
      dto.isActive === undefined &&
      dto.verificationStatus === undefined
    )
      throw new BadRequestException('At least one status field is required');
    const updated = await runSerializableTransaction(this.prisma, async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: adminUserSelect });
      if (!target) throw new NotFoundException('User not found');
      if (
        actor.role !== UserRole.SUPER_ADMIN &&
        [UserRole.SUPER_ADMIN, UserRole.FEDERATION_ADMIN].some(
          (role) => role === target.role || role === dto.role,
        )
      )
        throw new ForbiddenException(
          'Federation admins cannot manage administrator accounts or grant administrator roles',
        );
      if (
        target.role === UserRole.SUPER_ADMIN &&
        target.isActive &&
        (dto.isActive === false ||
          (dto.role !== undefined && dto.role !== UserRole.SUPER_ADMIN) ||
          (dto.verificationStatus !== undefined && dto.verificationStatus !== 'VERIFIED'))
      ) {
        if (
          (await tx.user.count({
            where: {
              role: UserRole.SUPER_ADMIN,
              isActive: true,
              OR: [
                { identityRecord: null },
                { identityRecord: { status: { notIn: ['REVOKED', 'FLAGGED_DUPLICATE'] } } },
              ],
            },
          })) <= 1
        )
          throw new ConflictException('Cannot revoke the last active super administrator');
      }
      if (dto.verificationStatus !== undefined) {
        if (!target.identityRecord)
          throw new BadRequestException(
            'Verification approval requires an existing government identity record',
          );
        await tx.identityVerification.update({
          where: { userId: id },
          data: { status: dto.verificationStatus },
        });
      }
      const user = await tx.user.update({
        where: { id },
        data: { role: dto.role, isActive: dto.isActive },
        select: adminUserSelect,
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, revoked: false },
        data: { revoked: true },
      });
      await tx.securityAuditLog.create({
        data: {
          userId: actor.sub,
          action: 'ADMIN_USER_STATUS_CHANGED',
          resource: 'user',
          resourceId: id,
          metadata: {
            before: {
              role: target.role,
              isActive: target.isActive,
              verificationStatus: target.identityRecord?.status ?? null,
            },
            after: {
              role: user.role,
              isActive: user.isActive,
              verificationStatus: user.identityRecord?.status ?? null,
            },
          },
        },
      });
      return user;
    });
    this.sockets.disconnectUser(id);
    await this.leaderboards.syncAthlete(id);
    return updated;
  }
  async tournaments(query: AdminTournamentsQuery): Promise<CursorPage<Tournament>> {
    return page(
      await this.prisma.tournament.findMany({
        where: query.status ? { status: query.status } : {},
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      query.limit,
    );
  }
  async moderateTournament(
    actor: AuthenticatedJwtUser,
    id: string,
    dto: AdminTournamentStatusDto,
  ): Promise<Tournament> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const tournament = await tx.tournament.findUnique({ where: { id } });
      if (!tournament) throw new NotFoundException('Tournament not found');
      let status = tournament.status;
      if (dto.action === ModerationAction.APPROVE) {
        if (
          !(['DRAFT', 'SUSPENDED'] as readonly TournamentStatus[]).includes(status) ||
          tournament.registrationDeadline < new Date()
        )
          throw new ConflictException(
            'Only a draft or suspended tournament with an open registration window can be approved',
          );
        status = TournamentStatus.REGISTRATION_OPEN;
      } else if (dto.action === ModerationAction.SUSPEND) {
        if (['COMPLETED', 'CANCELLED'].includes(status))
          throw new ConflictException('A closed tournament cannot be suspended');
        status = TournamentStatus.SUSPENDED;
      } else if (dto.action === ModerationAction.CLOSE) status = TournamentStatus.COMPLETED;
      const updated = await tx.tournament.update({
        where: { id },
        data: {
          status,
          ...(dto.action === ModerationAction.FEATURE ? { isFeatured: dto.featured ?? true } : {}),
          ...(dto.action === ModerationAction.SUSPEND || dto.action === ModerationAction.CLOSE
            ? { isFeatured: false }
            : {}),
        },
      });
      await tx.securityAuditLog.create({
        data: {
          userId: actor.sub,
          action: `ADMIN_TOURNAMENT_${dto.action}`,
          resource: 'tournament',
          resourceId: id,
          metadata: {
            previousStatus: tournament.status,
            status: updated.status,
            isFeatured: updated.isFeatured,
          },
        },
      });
      return updated;
    });
  }
  async auditLogs(query: AdminAuditQuery): Promise<CursorPage<SecurityAuditLog>> {
    return page(
      await this.prisma.securityAuditLog.findMany({
        where: { action: query.action, resource: query.resource, userId: query.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      query.limit,
    );
  }
}
