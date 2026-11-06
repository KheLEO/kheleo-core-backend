import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Tournament, TournamentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { HealthService, OperatorHealthResponse } from '../health/health.service';
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
export interface AdminDashboardResponse extends OperatorHealthResponse {
  readonly totalVerifiedAthletes: number;
  readonly totalOrganizersAndScouts: number;
  readonly totalVerifiedDrills: number;
  readonly totalSafetyMatchPauses: number;
  readonly totalSandbaggingBlocks: number;
  readonly verifiedAthletes: number;
  readonly activeTournaments: number;
  readonly organizers: number;
  readonly scouts: number;
  readonly verifiedDrills: number;
  readonly criticalMatchPauses: number;
}
export interface AdminPage<T> extends CursorPage<T> {
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly count: number;
}
const auditSelect = {
  id: true,
  category: true,
  severity: true,
  actorUserId: true,
  targetId: true,
  summary: true,
  metadata: true,
  ipHash: true,
  createdAt: true,
  action: true,
  userId: true,
  resource: true,
  resourceId: true,
} satisfies Prisma.SecurityAuditLogSelect;
export type AdminAuditRow = Prisma.SecurityAuditLogGetPayload<{ select: typeof auditSelect }>;
function page<T extends { id: string }>(rows: T[], limit: number): AdminPage<T> {
  return {
    data: rows.slice(0, limit),
    next_cursor: rows.length > limit ? rows[limit - 1].id : null,
    has_more: rows.length > limit,
    count: Math.min(rows.length, limit),
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
      totalOrganizersAndScouts,
      totalSafetyMatchPauses,
      totalSandbaggingBlocks,
      diagnostics,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { role: 'ATHLETE', isActive: true, identityRecord: { status: 'VERIFIED' } },
      }),
      this.prisma.tournament.count({
        where: { status: { in: ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'IN_PROGRESS'] } },
      }),
      this.prisma.user.count({ where: { role: 'ORGANIZER', isActive: true } }),
      this.prisma.user.count({ where: { role: 'SCOUT', isActive: true } }),
      this.prisma.drillSubmission.count({
        where: { metadataVerified: true, signatureVersion: { in: ['FULL', 'FULL_V2'] } },
      }),
      this.prisma.healthAlert.count({
        where: { severity: 'CRITICAL', matchPaused: true, matchId: { not: null } },
      }),
      this.prisma.user.count({ where: { role: { in: ['ORGANIZER', 'SCOUT'] } } }),
      this.prisma.securityAuditLog.count({ where: { category: 'SAFETY_MATCH_PAUSE' } }),
      this.prisma.securityAuditLog.count({ where: { category: 'SANDBAGGING_BLOCKED' } }),
      this.health.diagnostics(),
    ]);
    return {
      verifiedAthletes,
      activeTournaments,
      organizers,
      scouts,
      verifiedDrills,
      criticalMatchPauses,
      totalVerifiedAthletes: verifiedAthletes,
      totalOrganizersAndScouts,
      totalVerifiedDrills: verifiedDrills,
      totalSafetyMatchPauses,
      totalSandbaggingBlocks,
      ...diagnostics,
    };
  }
  async users(query: AdminUsersQuery): Promise<AdminPage<AdminUserResponse>> {
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query.role ? { role: query.role } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.verificationStatus
          ? { identityRecord: { status: query.verificationStatus } }
          : {}),
      },
      select: adminUserSelect,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...((query.cursor_id ?? query.cursor)
        ? { cursor: { id: query.cursor_id ?? query.cursor }, skip: 1 }
        : {}),
    });
    return page(rows, query.limit);
  }
  async updateUser(
    actor: AuthenticatedJwtUser,
    id: string,
    dto: AdminUserStatusDto,
  ): Promise<AdminUserResponse> {
    if (actor.role !== UserRole.SUPER_ADMIN)
      throw new ForbiddenException('Only super administrators can govern user accounts');
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
        data: {
          role: dto.role,
          isActive: dto.isActive,
          ...(dto.isActive !== undefined ? { isRecoveryBlocked: !dto.isActive } : {}),
        },
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
          category: 'ROLE_GOVERNANCE',
          actorUserId: actor.sub,
          targetId: id,
          severity:
            dto.isActive === false ||
            dto.verificationStatus === 'REVOKED' ||
            dto.verificationStatus === 'FLAGGED_DUPLICATE'
              ? 'WARNING'
              : 'INFO',
          summary:
            'Account role, activity or identity verification changed by a super administrator',
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
  async tournaments(query: AdminTournamentsQuery): Promise<AdminPage<Tournament>> {
    return page(
      await this.prisma.tournament.findMany({
        where: query.status ? { status: query.status } : {},
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        ...((query.cursor_id ?? query.cursor)
          ? { cursor: { id: query.cursor_id ?? query.cursor }, skip: 1 }
          : {}),
      }),
      query.limit,
    );
  }
  async moderateTournament(
    actor: AuthenticatedJwtUser,
    id: string,
    dto: AdminTournamentStatusDto,
  ): Promise<Tournament> {
    if (!['SUPER_ADMIN', 'FEDERATION_ADMIN'].includes(actor.role))
      throw new ForbiddenException('Administrator moderation required');
    if (
      dto.action === undefined &&
      dto.status === undefined &&
      dto.featured === undefined &&
      dto.suspended === undefined
    )
      throw new BadRequestException('Choose a moderation action');
    if (dto.action !== undefined && (dto.status !== undefined || dto.suspended !== undefined))
      throw new BadRequestException('Use either an action or explicit status fields');
    if (dto.suspended === true && dto.status !== undefined && dto.status !== 'SUSPENDED')
      throw new BadRequestException('Conflicting suspension and status');
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
      if (!dto.action) {
        if (dto.suspended === false && dto.status === undefined)
          throw new BadRequestException('Choose the status to restore after suspension');
        status = dto.suspended === true ? TournamentStatus.SUSPENDED : (dto.status ?? status);
        if (status === 'REGISTRATION_OPEN' && tournament.registrationDeadline < new Date())
          throw new ConflictException('The registration window has closed');
      }
      if (['COMPLETED', 'CANCELLED'].includes(tournament.status) && status !== tournament.status)
        throw new ConflictException('A closed tournament cannot be reopened');
      if (
        (dto.featured === true ||
          (dto.action === ModerationAction.FEATURE && dto.featured !== false)) &&
        ['SUSPENDED', 'COMPLETED', 'CANCELLED'].includes(status)
      )
        throw new ConflictException('Only an active tournament can be featured');
      const updated = await tx.tournament.update({
        where: { id },
        data: {
          status,
          ...(dto.action === ModerationAction.FEATURE
            ? { isFeatured: dto.featured ?? true }
            : dto.featured !== undefined
              ? { isFeatured: dto.featured }
              : {}),
          ...(['SUSPENDED', 'COMPLETED', 'CANCELLED'].includes(status)
            ? { isFeatured: false }
            : {}),
        },
      });
      await tx.securityAuditLog.create({
        data: {
          userId: actor.sub,
          action: `ADMIN_TOURNAMENT_${dto.action ?? (dto.suspended === true ? 'SUSPEND' : dto.status ? 'STATUS' : 'FEATURE')}`,
          category: 'TOURNAMENT_MODERATION',
          actorUserId: actor.sub,
          targetId: id,
          severity: ['SUSPENDED', 'CANCELLED'].includes(status) ? 'WARNING' : 'INFO',
          summary: 'Tournament status or featured placement moderated',
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
  async auditLogs(query: AdminAuditQuery): Promise<AdminPage<AdminAuditRow>> {
    return page(
      await this.prisma.securityAuditLog.findMany({
        where: {
          action: query.action,
          resource: query.resource,
          userId: query.userId,
          category: query.category,
          severity: query.severity,
        },
        select: auditSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...((query.cursor_id ?? query.cursor)
          ? { cursor: { id: query.cursor_id ?? query.cursor }, skip: 1 }
          : {}),
      }),
      query.limit,
    );
  }
}
