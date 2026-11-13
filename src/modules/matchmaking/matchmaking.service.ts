import { recordSandbaggingRejection } from '../tournaments/sandbagging-audit';
import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { MatchmakingGateway, RosterMemberPayload } from './matchmaking.gateway';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { bumpVersion, CACHE_KEYS } from '../../infrastructure/cache/cache-helper';
import { JoinFreeAgentDto } from './dto/join-free-agent.dto';
import {
  FreeAgentStatusResponseDto,
  RosterMemberSummaryDto,
} from './dto/free-agent-status-response.dto';
import { FreeAgentStatus, Prisma, RegistrationStatus, VerificationStatus } from '@prisma/client';
import * as crypto from 'node:crypto';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import {
  participationBracketSelect,
  participationProfileSelect,
  ParticipationProfile,
  readParticipationSnapshot,
  registrationIsOpen,
} from '../tournaments/participation-policy';
import {
  MatchingGtiBounds,
  RoleAssignment,
  RoleCandidate,
  RoleSlotRequirement,
  matchRoleSlots,
} from './role-matcher';

const queuedCandidateSelect = {
  id: true,
  userId: true,
  primaryRole: true,
  secondaryRole: true,
  joinedAt: true,
  user: {
    select: { email: true, phone: true, athleteProfile: { select: participationProfileSelect } },
  },
} satisfies Prisma.FreeAgentRegistrationSelect;
type QueuedCandidate = Prisma.FreeAgentRegistrationGetPayload<{
  select: typeof queuedCandidateSelect;
}>;
type EligibleCandidate = QueuedCandidate & {
  readonly user: QueuedCandidate['user'] & { readonly athleteProfile: ParticipationProfile };
};
interface CreatedRoster {
  readonly teamId: string;
  readonly teamName: string;
  readonly organizerId?: string;
  readonly roster: readonly RosterMemberPayload[];
}
function isEligibleCandidate(candidate: QueuedCandidate): candidate is EligibleCandidate {
  const profile = candidate.user.athleteProfile;
  return (
    profile !== null &&
    profile.user.isActive &&
    (!profile.user.identityRecord ||
      !['REVOKED', 'FLAGGED_DUPLICATE'].includes(profile.user.identityRecord.status)) &&
    Boolean(
      profile.dateOfBirth &&
      profile.gender &&
      profile.primarySport &&
      profile.district &&
      profile.state,
    )
  );
}

class RosterClaimConflictError extends Error {}

@Injectable()
export class MatchmakingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueProducer: QueueProducerService,
    private readonly gateway: MatchmakingGateway,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * Enqueues an athlete into the dynamic Free Agent Matchmaking Pool.
   * Runs Anti-Sandbagging gatekeeper, enforces duplicate checks, and dispatches BullMQ job.
   */
  async joinPool(
    tournamentId: string,
    bracketId: string,
    userId: string,
    dto: JoinFreeAgentDto,
  ): Promise<FreeAgentStatusResponseDto> {
    const { registration, waitPosition } = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const { bracket } = await readParticipationSnapshot(
          transaction,
          tournamentId,
          bracketId,
          userId,
        );
        const requirements = this.getSlotRequirements(
          bracket.tournament.sport,
          bracket.tournament.teamSize,
          bracket.config,
          bracket.tournament.rulesConfig,
        );
        const roles = [dto.primary_role, dto.secondary_role].filter((role): role is string =>
          Boolean(role),
        );
        if (!roles.some((role) => requirements.some((slot) => slot.rolePattern.test(role)))) {
          throw new BadRequestException('Submitted roles are not valid for this sport.');
        }
        const existingQueue = await transaction.freeAgentRegistration.findFirst({
          where: {
            userId,
            tournamentId,
            status: {
              in: [FreeAgentStatus.QUEUED, FreeAgentStatus.MATCHING],
            },
          },
          select: { id: true },
        });

        if (existingQueue) {
          throw new ConflictException(
            'Athlete is already queued in a free agent pool for this tournament.',
          );
        }

        const existingTeamMember = await transaction.teamMember.findFirst({
          where: { userId, team: { tournamentId } },
          select: { id: true },
        });

        if (existingTeamMember) {
          throw new ConflictException(
            'Athlete is already an active member of a registered team in this tournament.',
          );
        }

        const created = await transaction.freeAgentRegistration.create({
          data: {
            userId,
            tournamentId,
            bracketId,
            sport: bracket.tournament.sport,
            primaryRole: dto.primary_role.toUpperCase(),
            secondaryRole: dto.secondary_role ? dto.secondary_role.toUpperCase() : null,
            status: FreeAgentStatus.QUEUED,
          },
        });

        const position = await transaction.freeAgentRegistration.count({
          where: {
            bracketId,
            status: FreeAgentStatus.QUEUED,
            joinedAt: { lte: created.joinedAt },
          },
        });

        return { registration: created, waitPosition: position };
      },
    ).catch(async (error: unknown) => {
      await recordSandbaggingRejection(this.prisma, error, tournamentId, bracketId, userId);
      throw error;
    });

    // 7. Dispatch async matchmaking trigger to BullMQ queue
    await this.queueProducer.enqueueBracketMatchmaking({
      tournamentId,
      bracketId,
    });

    return {
      registrationId: registration.id,
      userId: registration.userId,
      tournamentId: registration.tournamentId,
      bracketId: registration.bracketId,
      sport: registration.sport,
      primaryRole: registration.primaryRole,
      secondaryRole: registration.secondaryRole,
      status: registration.status,
      waitPosition,
      joinedAt: registration.joinedAt.toISOString(),
    };
  }

  /**
   * Allows an athlete to leave the queue if still QUEUED.
   */
  async leavePool(
    tournamentId: string,
    bracketId: string,
    userId: string,
  ): Promise<{ message: string; cancelled: boolean }> {
    return runSerializableTransaction(this.prisma, async (transaction) => {
      const active = await transaction.freeAgentRegistration.findFirst({
        where: { userId, bracketId, tournamentId },
        orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (!active) throw new NotFoundException('No free agent registration found to cancel.');
      const result = await transaction.freeAgentRegistration.updateMany({
        where: { id: active.id, userId, tournamentId, bracketId, status: FreeAgentStatus.QUEUED },
        data: { status: FreeAgentStatus.CANCELLED },
      });
      if (result.count !== 1)
        throw new ConflictException(
          'Cannot leave pool: registration is already matched or cancelled',
        );
      return {
        message: 'Successfully removed from the free agent matchmaking pool.',
        cancelled: true,
      };
    });
  }

  /**
   * Introspects queue status, current wait position, or formed roster.
   */
  async getQueueStatus(
    tournamentId: string,
    bracketId: string,
    userId: string,
  ): Promise<FreeAgentStatusResponseDto> {
    const reg = await this.prisma.freeAgentRegistration.findFirst({
      where: {
        userId,
        bracketId,
        tournamentId,
      },
      orderBy: { joinedAt: 'desc' },
      select: {
        id: true,
        userId: true,
        tournamentId: true,
        bracketId: true,
        sport: true,
        primaryRole: true,
        secondaryRole: true,
        status: true,
        matchedTeamId: true,
        joinedAt: true,
        matchedTeam: {
          select: {
            name: true,
            members: {
              take: 50,
              select: {
                userId: true,
                athleteId: true,
                assignedRole: true,
                user: {
                  select: {
                    email: true,
                    phone: true,
                    athleteProfile: { select: { currentGti: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!reg) {
      throw new NotFoundException('No free agent registration record found for this bracket.');
    }

    let waitPosition = 0;
    if (reg.status === FreeAgentStatus.QUEUED) {
      waitPosition = await this.prisma.freeAgentRegistration.count({
        where: {
          bracketId,
          status: FreeAgentStatus.QUEUED,
          joinedAt: { lte: reg.joinedAt },
        },
      });
    }

    let roster: RosterMemberSummaryDto[] | null = null;
    let teamName: string | null = null;
    let assignedRole: string | null = null;

    if (reg.matchedTeam) {
      teamName = reg.matchedTeam.name;
      roster = reg.matchedTeam.members.map((m) => {
        const memberGti = m.user?.athleteProfile?.currentGti
          ? Number(m.user.athleteProfile.currentGti)
          : 50.0;
        const memberName = m.user?.email ?? m.user?.phone ?? 'Athlete';
        if (m.userId === userId) {
          assignedRole = m.assignedRole;
        }
        return {
          user_id: m.userId ?? m.athleteId ?? '',
          name: memberName,
          assigned_role: m.assignedRole,
          gti: memberGti,
        };
      });
    }

    return {
      registrationId: reg.id,
      userId: reg.userId,
      tournamentId: reg.tournamentId,
      bracketId: reg.bracketId,
      sport: reg.sport,
      primaryRole: reg.primaryRole,
      secondaryRole: reg.secondaryRole,
      status: reg.status,
      waitPosition,
      matchedTeamId: reg.matchedTeamId,
      teamName,
      assignedRole,
      roster,
      joinedAt: reg.joinedAt.toISOString(),
    };
  }

  /**
   * The Complementary Role Balancing Algorithm:
   * 1. Evaluates FIFO candidate pool for bracket.
   * 2. Matches required position slots per sport.
   * 3. Calculates proposed team mean GTI and checks bracket boundary compliance.
   * 4. Atomically creates Team, TeamMembers, sets MATCHED status, creates bracket Registration.
   * 5. Emits ROSTER_FORMED realtime WebSocket event.
   */
  async processBracketPool(tournamentId: string, bracketId: string): Promise<boolean> {
    let formed = false;
    while (true) {
      let created: CreatedRoster | null;
      try {
        created = await runSerializableTransaction(this.prisma, (transaction) =>
          this.formNextRoster(transaction, tournamentId, bracketId),
        );
      } catch (error: unknown) {
        if (error instanceof RosterClaimConflictError) return formed;
        throw error;
      }
      if (!created) return formed;
      if (created.organizerId) {
        await bumpVersion(this.redis, CACHE_KEYS.organizerVersion(created.organizerId));
      }
      await bumpVersion(this.redis, CACHE_KEYS.organizerVersion('GLOBAL'));
      this.gateway.emitRosterFormed({
        team_id: created.teamId,
        team_name: created.teamName,
        bracket_id: bracketId,
        roster: created.roster,
      });
      formed = true;
    }
  }

  private async formNextRoster(
    transaction: Prisma.TransactionClient,
    tournamentId: string,
    bracketId: string,
  ): Promise<CreatedRoster | null> {
    const bracket = await transaction.bracket.findUnique({
      where: { id: bracketId },
      select: participationBracketSelect,
    });
    if (
      !bracket ||
      bracket.tournamentId !== tournamentId ||
      !registrationIsOpen(bracket.tournament)
    )
      return null;
    const registered = await transaction.registration.count({
      where: { bracketId, status: RegistrationStatus.CONFIRMED },
    });
    if (registered >= bracket.maxTeams) return null;
    const slots = this.getSlotRequirements(
      bracket.tournament.sport,
      bracket.tournament.teamSize,
      bracket.config,
      bracket.tournament.rulesConfig,
    );
    const candidates = await this.loadCandidates(transaction, tournamentId, bracketId);
    const assigned = this.matchCandidatesToSlots(candidates, slots, {
      minGti: Number(bracket.minGti),
      maxGti: Number(bracket.maxGti),
      score: (candidate) => Number(candidate.user.athleteProfile.currentGti),
      identity: (candidate) => candidate.userId,
    });
    if (!assigned) return null;
    const meanGti = assigned
      .reduce(
        (sum, item) => sum.add(item.candidate.user.athleteProfile.currentGti),
        new Prisma.Decimal(0),
      )
      .div(assigned.length)
      .toNumber();
    const captainUserId = [...assigned].sort(
      (a, b) =>
        a.candidate.joinedAt.getTime() - b.candidate.joinedAt.getTime() ||
        a.candidate.id.localeCompare(b.candidate.id),
    )[0]!.candidate.userId;
    for (const { candidate } of assigned) {
      const claim = await transaction.freeAgentRegistration.updateMany({
        where: {
          id: candidate.id,
          userId: candidate.userId,
          tournamentId,
          bracketId,
          status: FreeAgentStatus.QUEUED,
        },
        data: { status: FreeAgentStatus.MATCHING },
      });
      if (claim.count !== 1)
        throw new RosterClaimConflictError(
          'Free agent was matched or cancelled by another execution.',
        );
    }
    const team = await transaction.team.create({
      data: {
        tournamentId,
        bracketId,
        captainId: captainUserId,
        name: 'FA-Roster-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
        isFreeAgentTeam: true,
        isFreeAgentFormed: true,
        compositeGti: meanGti,
        averageGti: meanGti,
      },
    });
    const roster: RosterMemberPayload[] = [];
    for (const { candidate, slotName } of assigned) {
      await transaction.teamMember.create({
        data: {
          teamId: team.id,
          userId: candidate.userId,
          athleteId: candidate.user.athleteProfile.id,
          assignedRole: slotName,
          isCaptain: candidate.userId === captainUserId,
        },
      });
      const result = await transaction.freeAgentRegistration.updateMany({
        where: { id: candidate.id, userId: candidate.userId, status: FreeAgentStatus.MATCHING },
        data: { status: FreeAgentStatus.MATCHED, matchedTeamId: team.id },
      });
      if (result.count !== 1)
        throw new RosterClaimConflictError('Free agent claim was lost before roster completion.');
      roster.push({
        user_id: candidate.userId,
        name: candidate.user.email ?? candidate.user.phone ?? 'Athlete',
        assigned_role: slotName,
        gti: Number(candidate.user.athleteProfile.currentGti),
      });
    }
    await transaction.registration.create({
      data: {
        bracketId,
        teamId: team.id,
        status: RegistrationStatus.CONFIRMED,
        feePaid: 0,
        metadata: {
          isFreeAgentFormedTeam: true,
          averageGti: meanGti,
          teamName: team.name,
          registeredAt: new Date().toISOString(),
        },
      },
    });
    return {
      teamId: team.id,
      teamName: team.name,
      organizerId: bracket.tournament.organizerId,
      roster,
    };
  }

  private async loadCandidates(
    transaction: Prisma.TransactionClient,
    tournamentId: string,
    bracketId: string,
  ): Promise<EligibleCandidate[]> {
    const candidates: EligibleCandidate[] = [];
    let cursor: { readonly id: string; readonly joinedAt: Date } | undefined;
    while (true) {
      const page: QueuedCandidate[] = await transaction.freeAgentRegistration.findMany({
        where: {
          tournamentId,
          bracketId,
          status: FreeAgentStatus.QUEUED,
          user: {
            isActive: true,
            OR: [
              { identityRecord: null },
              { identityRecord: { status: { notIn: ['REVOKED', 'FLAGGED_DUPLICATE'] } } },
            ],
            teamMembers: { none: { team: { tournamentId } } },
          },
          ...(cursor
            ? {
                OR: [
                  { joinedAt: { gt: cursor.joinedAt } },
                  { joinedAt: cursor.joinedAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        take: 200,
        select: queuedCandidateSelect,
      });
      for (const candidate of page) {
        if (isEligibleCandidate(candidate)) candidates.push(candidate);
      }
      if (page.length < 200) return candidates;
      const last = page.at(-1)!;
      if (cursor && last.id === cursor.id) throw new Error('Candidate pagination did not advance');
      cursor = { id: last.id, joinedAt: last.joinedAt };
    }
  }

  /**
   * Resolves sport-specific required team role compositions.
   */
  private getSlotRequirements(
    sport: string,
    teamSize?: number,
    bracketConfig?: Prisma.JsonValue,
    tournamentConfig?: Prisma.JsonValue,
  ): readonly RoleSlotRequirement[] {
    for (const config of [bracketConfig, tournamentConfig]) {
      if (!config || typeof config !== 'object' || Array.isArray(config) || !config.roleQuotas)
        continue;
      const quotas = config.roleQuotas;
      if (typeof quotas !== 'object' || Array.isArray(quotas))
        throw new BadRequestException('Invalid configured role quotas');
      const entries = Object.entries(quotas);
      if (
        entries.some(
          ([role, count]) =>
            !/^[A-Z][A-Z0-9_]{1,39}$/.test(role) ||
            typeof count !== 'number' ||
            !Number.isInteger(count) ||
            count < 0 ||
            count > 30,
        ) ||
        entries.reduce((sum, [, count]) => sum + Number(count), 0) !== teamSize
      )
        throw new BadRequestException('Configured role quotas must match teamSize');
      return entries.flatMap(([role, count]) =>
        Array.from({ length: Number(count) }, () => ({
          slotName: role,
          rolePattern: new RegExp(`^${role.replaceAll('_', '[_ ]')}$`, 'i'),
        })),
      );
    }
    const s = sport.toUpperCase();

    if (s.includes('CRICKET')) {
      const size = Math.max(4, teamSize ?? 7);
      const bowlerCount = Math.max(1, Math.floor((size - 2) * 0.4));
      const batsmanCount = size - bowlerCount - 2;
      return this.resizeSlotRequirements(
        [
          ...Array.from({ length: batsmanCount }, () => ({
            slotName: 'BATSMAN',
            rolePattern: /BAT/i,
          })),
          ...Array.from({ length: bowlerCount }, () => ({
            slotName: 'BOWLER',
            rolePattern: /BOWL/i,
          })),
          { slotName: 'ALL_ROUNDER', rolePattern: /ALL|ROUND/i },
          { slotName: 'WICKETKEEPER', rolePattern: /KEEP|WICKET/i },
        ],
        teamSize ?? 7,
      );
    }

    if (s.includes('FOOTBALL')) {
      const size = Math.max(4, teamSize ?? 7);
      const outfieldCount = size - 1;
      const defenderCount = Math.max(1, Math.floor(outfieldCount / 3));
      const midfielderCount = Math.max(1, Math.floor(outfieldCount / 3));
      const forwardCount = outfieldCount - defenderCount - midfielderCount;
      return this.resizeSlotRequirements(
        [
          { slotName: 'GOALKEEPER', rolePattern: /GOAL|GK/i },
          ...Array.from({ length: defenderCount }, () => ({
            slotName: 'DEFENDER',
            rolePattern: /DEF|BACK/i,
          })),
          ...Array.from({ length: midfielderCount }, () => ({
            slotName: 'MIDFIELDER',
            rolePattern: /MID/i,
          })),
          ...Array.from({ length: forwardCount }, () => ({
            slotName: 'FORWARD',
            rolePattern: /FORW|STRIK|WING/i,
          })),
        ],
        teamSize ?? 7,
      );
    }

    if (s.includes('BASKETBALL')) {
      const basketballSlots: readonly RoleSlotRequirement[] = [
        { slotName: 'POINT_GUARD', rolePattern: /POINT|GUARD/i },
        { slotName: 'SHOOTING_GUARD', rolePattern: /SHOOT|GUARD/i },
        { slotName: 'SMALL_FORWARD', rolePattern: /SMALL|FORW/i },
        { slotName: 'POWER_FORWARD', rolePattern: /POWER|FORW/i },
        { slotName: 'CENTER', rolePattern: /CENTER/i },
      ];
      return this.resizeSlotRequirements(basketballSlots, teamSize ?? 5);
    }

    // Generic fallback for custom sports
    const count = teamSize && teamSize > 0 ? teamSize : 5;
    const genericSlots: RoleSlotRequirement[] = [];
    for (let i = 1; i <= count; i++) {
      genericSlots.push({ slotName: `PLAYER_${i}`, rolePattern: /.*/ });
    }
    return genericSlots;
  }

  private resizeSlotRequirements(
    slots: readonly RoleSlotRequirement[],
    teamSize: number,
  ): readonly RoleSlotRequirement[] {
    if (teamSize <= slots.length) {
      return slots.slice(0, teamSize);
    }
    return [
      ...slots,
      ...Array.from({ length: teamSize - slots.length }, (_, index) => ({
        slotName: `PLAYER_${slots.length + index + 1}`,
        rolePattern: /.*/,
      })),
    ];
  }

  matchCandidatesToSlots<T extends RoleCandidate>(
    candidates: readonly T[],
    slots: readonly RoleSlotRequirement[],
    bounds?: MatchingGtiBounds<T>,
  ): readonly RoleAssignment<T>[] | null {
    return matchRoleSlots(candidates, slots, bounds);
  }
}
