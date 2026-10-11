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
import {
  FreeAgentRegistration,
  FreeAgentStatus,
  RegistrationStatus,
  TournamentStatus,
} from '@prisma/client';
import * as crypto from 'node:crypto';

interface RoleSlotRequirement {
  readonly slotName: string;
  readonly rolePattern: RegExp;
}

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
      include: {
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
      throw new BadRequestException(
        'Tournament is not currently open for registration.',
      );
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

    // 4. Duplicate checks
    // a. Check if user is already queued or matching in this tournament
    const existingQueue = await this.prisma.freeAgentRegistration.findFirst({
      where: {
        userId,
        tournamentId,
        status: { in: [FreeAgentStatus.QUEUED, FreeAgentStatus.MATCHING] },
      },
    });

    if (existingQueue) {
      throw new ConflictException(
        'Athlete is already queued in a free agent pool for this tournament.',
      );
    }

    // b. Check if user is already registered in a team for this tournament
    const existingTeamMember = await this.prisma.teamMember.findFirst({
      where: {
        userId,
        team: { tournamentId },
      },
    });

    if (existingTeamMember) {
      throw new ConflictException(
        'Athlete is already an active member of a registered team in this tournament.',
      );
    }

    // 5. Persist FreeAgentRegistration
    const registration = await this.prisma.freeAgentRegistration.create({
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

    // 6. Calculate wait position
    const waitPosition = await this.prisma.freeAgentRegistration.count({
      where: {
        bracketId,
        status: FreeAgentStatus.QUEUED,
        joinedAt: { lte: registration.joinedAt },
      },
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
    const active = await this.prisma.freeAgentRegistration.findFirst({
      where: {
        userId,
        bracketId,
        tournamentId,
        status: FreeAgentStatus.QUEUED,
      },
    });

    if (!active) {
      throw new NotFoundException(
        'No active queued free agent registration found to cancel.',
      );
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
      include: {
        matchedTeam: {
          include: {
            members: {
              include: {
                user: {
                  include: {
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
      throw new NotFoundException(
        'No free agent registration record found for this bracket.',
      );
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
  async processBracketPool(
    tournamentId: string,
    bracketId: string,
  ): Promise<boolean> {
    const bracket = await this.prisma.bracket.findUnique({
      where: { id: bracketId },
      include: {
        tournament: { select: { id: true, sport: true, teamSize: true } },
      },
    });

    if (!bracket) return false;

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
      include: {
        user: {
          include: {
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

    const createdRoster = await this.prisma.$transaction(async (tx) => {
      // 1. Create Team
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
        await tx.freeAgentRegistration.update({
          where: { id: item.candidate.id },
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
  private getSlotRequirements(
    sport: string,
    teamSize?: number,
  ): readonly RoleSlotRequirement[] {
    const s = sport.toUpperCase();

    if (s.includes('CRICKET')) {
      // 7-a-side Cricket: 3 Batsmen, 2 Bowlers, 1 All-rounder, 1 Wicketkeeper
      return [
        { slotName: 'BATSMAN', rolePattern: /BAT/i },
        { slotName: 'BATSMAN', rolePattern: /BAT/i },
        { slotName: 'BATSMAN', rolePattern: /BAT/i },
        { slotName: 'BOWLER', rolePattern: /BOWL/i },
        { slotName: 'BOWLER', rolePattern: /BOWL/i },
        { slotName: 'ALL_ROUNDER', rolePattern: /ALL|ROUND/i },
        { slotName: 'WICKETKEEPER', rolePattern: /KEEP|WICKET/i },
      ];
    }

    if (s.includes('FOOTBALL')) {
      // 7-a-side Football: 1 GK, 2 DEF, 2 MID, 2 FWD
      return [
        { slotName: 'GOALKEEPER', rolePattern: /GOAL|GK/i },
        { slotName: 'DEFENDER', rolePattern: /DEF|BACK/i },
        { slotName: 'DEFENDER', rolePattern: /DEF|BACK/i },
        { slotName: 'MIDFIELDER', rolePattern: /MID/i },
        { slotName: 'MIDFIELDER', rolePattern: /MID/i },
        { slotName: 'FORWARD', rolePattern: /FORW|STRIK|WING/i },
        { slotName: 'FORWARD', rolePattern: /FORW|STRIK|WING/i },
      ];
    }

    if (s.includes('BASKETBALL')) {
      return [
        { slotName: 'POINT_GUARD', rolePattern: /POINT|GUARD/i },
        { slotName: 'SHOOTING_GUARD', rolePattern: /SHOOT|GUARD/i },
        { slotName: 'SMALL_FORWARD', rolePattern: /SMALL|FORW/i },
        { slotName: 'POWER_FORWARD', rolePattern: /POWER|FORW/i },
        { slotName: 'CENTER', rolePattern: /CENTER/i },
      ];
    }

    // Generic fallback for custom sports
    const count = teamSize && teamSize > 0 ? teamSize : 5;
    const genericSlots: RoleSlotRequirement[] = [];
    for (let i = 1; i <= count; i++) {
      genericSlots.push({ slotName: `PLAYER_${i}`, rolePattern: /.*/ });
    }
    return genericSlots;
  }

  /**
   * Greedy bipartite slot matching:
   * Maps available candidates to required role slots using primaryRole first, then secondaryRole fallback.
   */
  private matchCandidatesToSlots<
    T extends { primaryRole: string; secondaryRole: string | null },
  >(
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
            if (
              candidate.secondaryRole &&
              slot.rolePattern.test(candidate.secondaryRole)
            ) {
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
