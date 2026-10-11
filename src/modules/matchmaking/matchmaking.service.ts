import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import { MatchmakingGateway, RosterMemberPayload } from './matchmaking.gateway';
import { JoinFreeAgentDto } from './dto/join-free-agent.dto';
import {
  FreeAgentStatusResponseDto,
  RosterMemberSummaryDto,
} from './dto/free-agent-status-response.dto';
import { FreeAgentStatus, RegistrationStatus, TournamentStatus } from '@prisma/client';
import * as crypto from 'node:crypto';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';

interface RoleSlotRequirement {
  readonly slotName: string;
  readonly rolePattern: RegExp;
}

class RosterClaimConflictError extends Error {}

@Injectable()
export class MatchmakingService {
  private readonly logger = new Logger(MatchmakingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueProducer: QueueProducerService,
    private readonly gateway: MatchmakingGateway,
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
    // 1. Resolve athlete profile and GTI
    const athleteProfile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      select: { id: true, currentGti: true },
    });

    if (!athleteProfile) {
      throw new BadRequestException(
        'Athlete profile must be created before joining the free agent matchmaking pool.',
      );
    }

    const athleteGti = Number(athleteProfile.currentGti);

    // 2. Validate bracket & tournament existence
    const bracket = await this.prisma.bracket.findUnique({
      where: { id: bracketId },
      select: {
        id: true,
        tournamentId: true,
        tierName: true,
        minGti: true,
        maxGti: true,
        tournament: {
          select: { id: true, status: true, sport: true, teamSize: true },
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

    // 3. Anti-Sandbagging Gatekeeper validation
    if (athleteGti > maxGti) {
      this.logger.warn(
        `Anti-Sandbagging Check Failed in Free Agent Queue: User ${userId} (GTI: ${athleteGti}) attempted entry into Bracket ${bracket.tierName} (Max: ${maxGti})`,
      );
      throw new ConflictException({
        code: 'SANDBAGGING_DETECTED',
        error: 'Conflict',
        message: `Athlete GTI (${athleteGti.toFixed(2)}) exceeds bracket maximum ceiling (${maxGti.toFixed(2)}). Anti-sandbagging policy prohibits over-qualified free agents from this pool tier.`,
        athleteGti,
        bracketMaxGti: maxGti,
        bracketMinGti: minGti,
      });
    }

    if (athleteGti < minGti) {
      throw new ConflictException({
        code: 'BELOW_MINIMUM_TIER',
        error: 'Conflict',
        message: `Athlete GTI (${athleteGti.toFixed(2)}) is below the minimum threshold (${minGti.toFixed(2)}) for this tier.`,
        athleteGti,
        bracketMinGti: minGti,
        bracketMaxGti: maxGti,
      });
    }

    const roleRequirements = this.getSlotRequirements(
      bracket.tournament.sport,
      bracket.tournament.teamSize,
    );
    const submittedRoles = [dto.primary_role, dto.secondary_role].filter((role): role is string =>
      Boolean(role),
    );
    if (
      !submittedRoles.some((role) =>
        roleRequirements.some((requirement) => requirement.rolePattern.test(role)),
      )
    ) {
      throw new BadRequestException(
        `Submitted roles are not valid for ${bracket.tournament.sport}.`,
      );
    }

    const { registration, waitPosition } = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
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
    );

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
    const active = await this.prisma.freeAgentRegistration.findFirst({
      where: {
        userId,
        bracketId,
        tournamentId,
        status: FreeAgentStatus.QUEUED,
      },
    });

    if (!active) {
      throw new NotFoundException('No active queued free agent registration found to cancel.');
    }

    await this.prisma.freeAgentRegistration.update({
      where: { id: active.id },
      data: { status: FreeAgentStatus.CANCELLED },
    });

    return {
      message: 'Successfully removed from the free agent matchmaking pool.',
      cancelled: true,
    };
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
    const bracket = await this.prisma.bracket.findUnique({
      where: { id: bracketId },
      select: {
        id: true,
        tournamentId: true,
        minGti: true,
        maxGti: true,
        entryFee: true,
        maxTeams: true,
        tournament: { select: { id: true, sport: true, teamSize: true } },
      },
    });

    if (!bracket || bracket.tournamentId !== tournamentId) return false;

    // Define complementary role composition for the sport
    const slotRequirements = this.getSlotRequirements(
      bracket.tournament.sport,
      bracket.tournament.teamSize,
    );
    const requiredTeamSize = slotRequirements.length;

    // Query candidates ordered by joinedAt ASC (FIFO)
    const candidates = await this.prisma.freeAgentRegistration.findMany({
      where: {
        bracketId,
        status: FreeAgentStatus.QUEUED,
      },
      orderBy: { joinedAt: 'asc' },
      take: Math.min(200, requiredTeamSize * 10),
      select: {
        id: true,
        userId: true,
        primaryRole: true,
        secondaryRole: true,
        joinedAt: true,
        user: {
          select: {
            email: true,
            phone: true,
            athleteProfile: { select: { currentGti: true } },
          },
        },
      },
    });

    if (candidates.length < requiredTeamSize) {
      this.logger.debug(
        `Insufficient candidates for Bracket ${bracketId} (${candidates.length}/${requiredTeamSize} needed).`,
      );
      return false;
    }

    // Role-balancing slot assignment
    const assigned = this.matchCandidatesToSlots(candidates, slotRequirements);
    if (!assigned) {
      this.logger.debug(
        `Role composition criteria not yet met for Bracket ${bracketId}. Waiting for matching specialists.`,
      );
      return false;
    }

    // Skill-variance check: calculate Mean GTI
    const totalGti = assigned.reduce((sum, item) => {
      const gti = item.candidate.user.athleteProfile?.currentGti
        ? Number(item.candidate.user.athleteProfile.currentGti)
        : 30.0;
      return sum + gti;
    }, 0);
    const meanGti = Math.round((totalGti / requiredTeamSize) * 100) / 100;

    const minGti = Number(bracket.minGti);
    const maxGti = Number(bracket.maxGti);

    if (meanGti < minGti || meanGti > maxGti) {
      this.logger.warn(
        `Proposed team mean GTI (${meanGti}) outside bracket range [${minGti}, ${maxGti}]. Skipping batch.`,
      );
      return false;
    }

    // Atomic execution inside Prisma $transaction
    const shortId = crypto.randomBytes(2).toString('hex').toUpperCase();
    const teamName = `FA-Roster-${shortId}`;

    let createdRoster: {
      readonly teamId: string;
      readonly teamName: string;
      readonly bracketId: string;
      readonly roster: readonly RosterMemberPayload[];
    };

    try {
      createdRoster = await runSerializableTransaction(this.prisma, async (tx) => {
        for (const item of assigned) {
          const claim = await tx.freeAgentRegistration.updateMany({
            where: { id: item.candidate.id, status: FreeAgentStatus.QUEUED },
            data: { status: FreeAgentStatus.MATCHING },
          });
          if (claim.count !== 1) {
            throw new RosterClaimConflictError(
              `Free agent ${item.candidate.id} was claimed by another worker.`,
            );
          }
        }

        const registeredTeamCount = await tx.registration.count({
          where: {
            bracketId,
            status: RegistrationStatus.CONFIRMED,
            teamId: { not: null },
          },
        });
        if (registeredTeamCount >= bracket.maxTeams) {
          throw new ConflictException('Bracket team capacity has been reached.');
        }

        const team = await tx.team.create({
          data: {
            tournamentId,
            bracketId,
            name: teamName,
            isFreeAgentTeam: true,
            isFreeAgentFormed: true,
            compositeGti: meanGti,
            averageGti: meanGti,
          },
        });

        // 2. Create TeamMembers
        const rosterList: RosterMemberPayload[] = [];
        for (let i = 0; i < assigned.length; i++) {
          const item = assigned[i]!;
          const gti = item.candidate.user.athleteProfile?.currentGti
            ? Number(item.candidate.user.athleteProfile.currentGti)
            : 50.0;
          const name =
            item.candidate.user.email ??
            item.candidate.user.phone ??
            `Athlete ${item.candidate.userId.substring(0, 4)}`;

          await tx.teamMember.create({
            data: {
              teamId: team.id,
              userId: item.candidate.userId,
              assignedRole: item.slotName,
              isCaptain: i === 0, // First candidate designated as captain
            },
          });

          // 3. Update FreeAgentRegistration status
          await tx.freeAgentRegistration.updateMany({
            where: {
              id: item.candidate.id,
              status: FreeAgentStatus.MATCHING,
            },
            data: {
              status: FreeAgentStatus.MATCHED,
              matchedTeamId: team.id,
            },
          });

          rosterList.push({
            user_id: item.candidate.userId,
            name,
            assigned_role: item.slotName,
            gti,
          });
        }

        // 4. Create final bracket Registration
        await tx.registration.create({
          data: {
            bracketId,
            teamId: team.id,
            status: RegistrationStatus.CONFIRMED,
            feePaid: bracket.entryFee,
            metadata: {
              isFreeAgentFormedTeam: true,
              teamName,
              averageGti: meanGti,
              registeredAt: new Date().toISOString(),
            },
          },
        });

        return {
          teamId: team.id,
          teamName,
          bracketId,
          roster: rosterList,
        };
      });
    } catch (error: unknown) {
      if (error instanceof RosterClaimConflictError) {
        this.logger.debug(error.message);
        return false;
      }
      throw error;
    }

    // 5. Realtime roster notification via WebSocket
    this.gateway.emitRosterFormed({
      team_id: createdRoster.teamId,
      team_name: createdRoster.teamName,
      bracket_id: createdRoster.bracketId,
      roster: createdRoster.roster,
    });

    return true;
  }

  /**
   * Resolves sport-specific required team role compositions.
   */
  private getSlotRequirements(sport: string, teamSize?: number): readonly RoleSlotRequirement[] {
    const s = sport.toUpperCase();

    if (s.includes('CRICKET')) {
      const size = Math.max(4, teamSize ?? 7);
      const bowlerCount = Math.max(1, Math.floor((size - 2) * 0.4));
      const batsmanCount = size - bowlerCount - 2;
      return [
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
      ];
    }

    if (s.includes('FOOTBALL')) {
      const size = Math.max(4, teamSize ?? 7);
      const outfieldCount = size - 1;
      const defenderCount = Math.max(1, Math.floor(outfieldCount / 3));
      const midfielderCount = Math.max(1, Math.floor(outfieldCount / 3));
      const forwardCount = outfieldCount - defenderCount - midfielderCount;
      return [
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
      ];
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

  /**
   * Greedy bipartite slot matching:
   * Maps available candidates to required role slots using primaryRole first, then secondaryRole fallback.
   */
  private matchCandidatesToSlots<T extends { primaryRole: string; secondaryRole: string | null }>(
    candidates: readonly T[],
    slots: readonly RoleSlotRequirement[],
  ): ReadonlyArray<{ slotName: string; candidate: T }> | null {
    const usedCandidateIndices = new Set<number>();
    const result: Array<{ slotName: string; candidate: T }> = [];

    // Phase 1: Try primary role match
    for (const slot of slots) {
      let matchedIndex = -1;
      for (let i = 0; i < candidates.length; i++) {
        if (!usedCandidateIndices.has(i)) {
          const candidate = candidates[i]!;
          if (slot.rolePattern.test(candidate.primaryRole)) {
            matchedIndex = i;
            break;
          }
        }
      }

      // Phase 2: Try secondary role fallback if no primary match
      if (matchedIndex === -1) {
        for (let i = 0; i < candidates.length; i++) {
          if (!usedCandidateIndices.has(i)) {
            const candidate = candidates[i]!;
            if (candidate.secondaryRole && slot.rolePattern.test(candidate.secondaryRole)) {
              matchedIndex = i;
              break;
            }
          }
        }
      }

      // Phase 3: For wildcard/generic fallback
      if (matchedIndex === -1 && slot.rolePattern.source === '.*') {
        for (let i = 0; i < candidates.length; i++) {
          if (!usedCandidateIndices.has(i)) {
            matchedIndex = i;
            break;
          }
        }
      }

      if (matchedIndex === -1) {
        return null; // Cannot satisfy this slot
      }

      usedCandidateIndices.add(matchedIndex);
      result.push({
        slotName: slot.slotName,
        candidate: candidates[matchedIndex]!,
      });
    }

    return result;
  }
}
