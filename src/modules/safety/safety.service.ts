import { assertTournamentOwner } from '../tournaments/tournament-policy';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AlertSeverity,
  HealthAlert,
  Match,
  MatchStatus,
  Prisma,
  TelemetrySource,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { WsEventGateway } from '../../infrastructure/realtime/ws-event.gateway';
import { QueueProducerService } from '../../infrastructure/queues/queue-producer.service';
import {
  TelemetryWebhookDto,
  TelemetryResponseDto,
  SafetyAlertsQueryDto,
  AcknowledgeSafetyDto,
  ResumeSafetyDto,
} from './dto/telemetry-webhook.dto';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { assertAccountAccess } from '../../common/auth/account-access';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import {
  assertMatchOperator,
  matchContextSelect,
  matchParticipants,
} from '../../common/competition/match-access';

import { randomUUID } from 'node:crypto';
import { CursorPage } from '../../common/dto/cursor-page';

@Injectable()
export class SafetyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wsGateway: WsEventGateway,
    private readonly queue: QueueProducerService,
  ) {}

  async processTelemetry(
    dto: TelemetryWebhookDto,
    source: TelemetrySource = TelemetrySource.DEVICE_HMAC,
  ): Promise<TelemetryResponseDto> {
    if (
      (dto.baseline_fields?.includes('spo2') && dto.spo2 !== 98) ||
      (dto.baseline_fields?.includes('skin_temperature') && dto.skin_temperature !== 36.8)
    )
      throw new BadRequestException(
        'Baseline fields must use the documented physiological defaults',
      );
    const timestamp = dto.timestamp > 1e11 ? dto.timestamp : dto.timestamp * 1000;
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 300000)
      throw new BadRequestException('Telemetry timestamp must be within 300 seconds');
    const critical = dto.heart_rate > 195 || dto.spo2 < 90 || dto.skin_temperature > 39.5;
    const warning =
      !critical && (dto.heart_rate > 185 || dto.spo2 < 93 || dto.skin_temperature > 38.5);
    const severity = critical
      ? AlertSeverity.CRITICAL
      : warning
        ? AlertSeverity.WARNING
        : AlertSeverity.NORMAL;
    const reason = `${source === TelemetrySource.SIMULATOR ? 'SIMULATOR STRESS TEST: ' : ''}${critical ? 'CRITICAL BIOMETRIC EXTREME' : 'WARNING BIOMETRIC ELEVATION'}`;
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const profile = await tx.athleteProfile.findUnique({
        where: { userId: dto.athlete_id },
        include: { user: { include: { identityRecord: true } } },
      });
      if (!profile || profile.user.role !== UserRole.ATHLETE)
        throw new NotFoundException('Athlete profile not found');
      assertAccountAccess(profile.user);
      let tournamentId = dto.tournament_id;
      let bracketId = dto.bracket_id;
      let paused = false;
      if (dto.match_id) {
        const match = await tx.match.findUnique({
          where: { id: dto.match_id },
          select: matchContextSelect,
        });
        if (
          !match ||
          !matchParticipants(match).includes(dto.athlete_id) ||
          (bracketId && bracketId !== match.bracketId) ||
          (tournamentId && tournamentId !== match.bracket.tournamentId)
        )
          throw new BadRequestException(
            'Telemetry athlete or context does not belong to this match',
          );
        const active: readonly MatchStatus[] = ['WARMUP', 'LIVE', 'PAUSED_SAFETY'];
        if (!active.includes(match.status)) throw new ConflictException('Match is not active');
        bracketId = match.bracketId;
        tournamentId = match.bracket.tournamentId;
        paused = critical && match.status !== MatchStatus.PAUSED_SAFETY;
        if (paused)
          await tx.match.update({
            where: { id: match.id },
            data: { status: MatchStatus.PAUSED_SAFETY, pauseReason: reason, pausedAt: new Date() },
          });
      } else if (bracketId || tournamentId) {
        const registration = await tx.registration.findFirst({
          where: {
            status: 'CONFIRMED',
            ...(bracketId ? { bracketId } : {}),
            bracket: { ...(tournamentId ? { tournamentId } : {}) },
            OR: [
              { userId: dto.athlete_id },
              {
                team: {
                  members: {
                    some: {
                      OR: [{ userId: dto.athlete_id }, { athlete: { userId: dto.athlete_id } }],
                    },
                  },
                },
              },
            ],
          },
          include: { bracket: true },
        });
        if (!registration)
          throw new BadRequestException('Athlete is not registered in this context');
        bracketId = registration.bracketId;
        tournamentId = registration.bracket.tournamentId;
      }
      if (tournamentId) {
        const previous = await tx.tournamentVital.findUnique({
          where: { tournamentId_athleteId: { tournamentId, athleteId: dto.athlete_id } },
        });
        if (previous && previous.observedAt.getTime() > timestamp)
          throw new ConflictException('Telemetry is older than the latest snapshot');
        const snapshot = {
          heartRate: dto.heart_rate,
          spo2: dto.spo2,
          skinTemperature: dto.skin_temperature,
          severity,
          source,
          baselineFields: dto.baseline_fields ?? [],
          observedAt: new Date(timestamp),
          receivedAt: new Date(),
          bracketId: bracketId ?? null,
          matchId: dto.match_id ?? null,
        };
        await tx.tournamentVital.upsert({
          where: { tournamentId_athleteId: { tournamentId, athleteId: dto.athlete_id } },
          create: { tournamentId, athleteId: dto.athlete_id, ...snapshot },
          update: snapshot,
        });
      }
      const day = new Date(timestamp);
      day.setUTCHours(0, 0, 0, 0);
      await tx.wearableSession.upsert({
        where: { athleteId_sessionDate: { athleteId: dto.athlete_id, sessionDate: day } },
        create: {
          athleteId: dto.athlete_id,
          sessionDate: day,
          readingsCount: 1,
          heartRateSum: dto.heart_rate,
          spo2Sum: dto.spo2,
          simulatorReadings: source === TelemetrySource.SIMULATOR ? 1 : 0,
          baselineSpo2Readings: dto.baseline_fields?.includes('spo2') ? 1 : 0,
          source,
          baselineFields: dto.baseline_fields ?? [],
        },
        update: {
          observedAt: new Date(),
          source,
          baselineFields: dto.baseline_fields ?? [],
          readingsCount: { increment: 1 },
          heartRateSum: { increment: dto.heart_rate },
          spo2Sum: { increment: dto.spo2 },
          simulatorReadings: { increment: source === TelemetrySource.SIMULATOR ? 1 : 0 },
          baselineSpo2Readings: { increment: dto.baseline_fields?.includes('spo2') ? 1 : 0 },
        },
      });
      const since = new Date(day);
      since.setUTCDate(since.getUTCDate() - 29);
      const sessions = await tx.wearableSession.count({
        where: { athleteId: dto.athlete_id, sessionDate: { gte: since, lte: day } },
      });
      const score = Math.min(100, sessions * 5);
      await tx.athleteProfile.update({
        where: { id: profile.id },
        data: { trainingConsistencyScore: score, wearableScore: new Prisma.Decimal(score) },
      });
      let alert: HealthAlert | null = null;
      if (severity !== AlertSeverity.NORMAL) {
        const existing = await tx.healthAlert.findFirst({
          where: {
            athleteId: dto.athlete_id,
            tournamentId: tournamentId ?? null,
            matchId: dto.match_id ?? null,
            severity,
            source,
            acknowledgedAt: null,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const data = {
          athleteId: dto.athlete_id,
          matchId: dto.match_id ?? null,
          tournamentId: tournamentId ?? null,
          bracketId: bracketId ?? null,
          severity,
          heartRate: dto.heart_rate,
          spo2: dto.spo2,
          skinTemperature: dto.skin_temperature,
          triggerReason: reason,
          matchPaused: existing?.matchPaused || paused,
          source,
          baselineFields: dto.baseline_fields ?? [],
        };
        alert = existing
          ? await tx.healthAlert.update({ where: { id: existing.id }, data })
          : await tx.healthAlert.create({ data });
      }
      return {
        alertId: alert?.id,
        paused,
        tournamentId,
        bracketId,
        name: profile.user.email ?? profile.user.phone ?? `Athlete ${dto.athlete_id.slice(0, 8)}`,
      };
    });
    if (result.tournamentId)
      this.wsGateway.broadcastVitalsUpdated({
        tournament_id: result.tournamentId,
        athlete_id: dto.athlete_id,
        heart_rate: dto.heart_rate,
        spo2: dto.spo2,
        skin_temperature: dto.skin_temperature,
        severity,
        observed_at: new Date(timestamp).toISOString(),
        source,
        baseline_fields: dto.baseline_fields ?? [],
        match_id: dto.match_id,
        bracket_id: result.bracketId,
      });
    if (critical)
      this.wsGateway.broadcastAutonomousMatchPause({
        event_id: randomUUID(),
        alert_id: result.alertId,
        source,
        baseline_fields: dto.baseline_fields ?? [],
        event: 'MATCH_PAUSE_ALERT',
        severity: 'CRITICAL',
        athlete_id: dto.athlete_id,
        athlete_name: result.name,
        vitals: {
          heart_rate: dto.heart_rate,
          spo2: dto.spo2,
          skin_temperature: dto.skin_temperature,
        },
        directive:
          source === TelemetrySource.SIMULATOR
            ? 'SIMULATOR STRESS TEST: MANDATORY REST'
            : 'MANDATORY REST: PAUSE ACTIVITY IMMEDIATELY',
        tournament_id: result.tournamentId,
        bracket_id: result.bracketId,
        match_id: dto.match_id,
      });
    await this.queue.enqueueGtiRecalculation({
      athleteId: dto.athlete_id,
      trigger: 'WEARABLE_SYNC',
    });
    return {
      alert_triggered: critical || warning,
      status: result.paused
        ? 'MATCH_PAUSED'
        : critical
          ? 'CRITICAL_ALERT'
          : warning
            ? 'WARNING'
            : 'NORMAL',
      ...(critical || warning ? { message: reason } : {}),
    };
  }

  async listAlerts(
    actor: AuthenticatedJwtUser,
    query: SafetyAlertsQueryDto,
  ): Promise<CursorPage<HealthAlert>> {
    const where: Prisma.HealthAlertWhereInput = {
      ...(query.tournament_id ? { tournamentId: query.tournament_id } : {}),
      ...(query.bracket_id ? { bracketId: query.bracket_id } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...([UserRole.SUPER_ADMIN, UserRole.FEDERATION_ADMIN].some((role) => role === actor.role)
        ? {}
        : actor.role === UserRole.ORGANIZER
          ? { tournament: { organizerId: actor.sub } }
          : { match: { umpireId: actor.sub } }),
    };
    const rows = await this.prisma.healthAlert.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    return {
      data: rows.slice(0, query.limit),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1].id : null,
    };
  }

  async acknowledge(
    actor: AuthenticatedJwtUser,
    id: string,
    dto: AcknowledgeSafetyDto,
  ): Promise<HealthAlert> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const alert = await tx.healthAlert.findUnique({
        where: { id },
        include: { tournament: true, match: { select: matchContextSelect } },
      });
      if (!alert) throw new NotFoundException('Safety alert not found');
      assertMatchOperator(actor, alert.tournament?.organizerId ?? '', alert.match ?? undefined);
      if (alert.acknowledgedAt) return alert;
      if (
        dto.medicalCheckDispatched !== true ||
        typeof dto.medicalCheckNote !== 'string' ||
        dto.medicalCheckNote.trim().length < 5 ||
        dto.medicalCheckNote.length > 1000
      )
        throw new BadRequestException('Confirm the medical check and record a note');
      if (alert.severity === 'CRITICAL' && alert.matchId && alert.match?.status !== 'PAUSED_SAFETY')
        throw new ConflictException(
          'Confirm the match is paused before acknowledging this critical incident',
        );
      const updated = await tx.healthAlert.update({
        where: { id },
        data: {
          acknowledgedAt: new Date(),
          acknowledgedById: actor.sub,
          medicalCheckNote: dto.medicalCheckNote,
          medicalCheckDispatched: dto.medicalCheckDispatched,
        },
      });
      await tx.securityAuditLog.create({
        data: {
          userId: actor.sub,
          action: 'SAFETY_ALERT_ACKNOWLEDGED',
          metadata: {
            medicalCheckNote: dto.medicalCheckNote ?? null,
            medicalCheckDispatched: dto.medicalCheckDispatched,
          },
          resource: 'health_alert',
          resourceId: id,
        },
      });
      return updated;
    });
  }

  async resume(
    actor: AuthenticatedJwtUser,
    matchId: string,
    dto?: ResumeSafetyDto,
  ): Promise<Match> {
    if (
      dto?.medicalClearanceConfirmed !== true ||
      typeof dto.medicalClearanceNote !== 'string' ||
      dto.medicalClearanceNote.trim().length < 5 ||
      dto.medicalClearanceNote.length > 1000
    )
      throw new BadRequestException('Explicit medical clearance and a note are required');
    return runSerializableTransaction(this.prisma, async (tx) => {
      const match = await tx.match.findUnique({
        where: { id: matchId },
        select: matchContextSelect,
      });
      if (!match) throw new NotFoundException('Match not found');
      assertMatchOperator(actor, match.bracket.tournament.organizerId, match);
      if (match.status !== MatchStatus.PAUSED_SAFETY)
        throw new ConflictException('Match is not paused for safety');
      if (
        await tx.healthAlert.count({
          where: { matchId, severity: AlertSeverity.CRITICAL, acknowledgedAt: null },
        })
      )
        throw new ConflictException('Acknowledge outstanding critical alerts before resuming');
      const updated = await tx.match.update({
        where: { id: matchId },
        data: { status: MatchStatus.LIVE, pauseReason: null, pausedAt: null },
      });
      await tx.securityAuditLog.create({
        data: {
          userId: actor.sub,
          action: 'SAFETY_MATCH_RESUMED',
          metadata: {
            medicalClearanceNote: dto.medicalClearanceNote,
            medicalClearanceConfirmed: true,
          },
          resource: 'match',
          resourceId: matchId,
        },
      });
      return updated;
    });
  }
  private async assertTournamentAccess(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
  ): Promise<void> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { organizerId: true },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    assertTournamentOwner(tournament.organizerId, actor);
  }
  async tournamentAlerts(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<HealthAlert>> {
    await this.assertTournamentAccess(actor, tournamentId);
    const rows = await this.prisma.healthAlert.findMany({
      where: { tournamentId, ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}) },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return PaginatedResponseDto.create(rows, query.limit, (row) => row.id);
  }
  async tournamentVitals(
    actor: AuthenticatedJwtUser,
    tournamentId: string,
    query: CursorPaginationQueryDto,
  ) {
    await this.assertTournamentAccess(actor, tournamentId);
    const registered = { status: 'CONFIRMED' as const, bracket: { tournamentId } };
    const users = await this.prisma.user.findMany({
      where: {
        role: 'ATHLETE',
        isActive: true,
        ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}),
        OR: [
          { registrations: { some: registered } },
          { teamMembers: { some: { team: { registrations: { some: registered } } } } },
          {
            athleteProfile: {
              teamMemberships: { some: { team: { registrations: { some: registered } } } },
            },
          },
        ],
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      select: {
        id: true,
        email: true,
        phone: true,
        tournamentVitals: { where: { tournamentId }, take: 1 },
        healthAlerts: {
          where: { tournamentId, severity: 'CRITICAL', acknowledgedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
    });
    const matches = await this.prisma.match.findMany({
      where: { bracket: { tournamentId }, status: { in: ['WARMUP', 'LIVE', 'PAUSED_SAFETY'] } },
      select: { ...matchContextSelect, pauseReason: true },
    });
    const data = users.map((user) => {
      const reading = user.tournamentVitals[0];
      const match = matches.find((entry) => matchParticipants(entry).includes(user.id));
      return {
        athleteId: user.id,
        name: user.email ?? user.phone ?? user.id,
        heart_rate: reading?.heartRate ?? null,
        spo2: reading?.spo2 ?? null,
        skin_temperature: reading?.skinTemperature ?? null,
        severity: reading?.severity ?? 'AWAITING_READING',
        observedAt: reading?.observedAt ?? null,
        source: reading?.source ?? null,
        baseline_fields: reading?.baselineFields ?? [],
        matchId: match?.id ?? null,
        matchStatus: match?.status ?? null,
      };
    });
    return {
      ...PaginatedResponseDto.create(data, query.limit, (row) => row.athleteId),
      activeAlerts: users.slice(0, query.limit).flatMap((user) => user.healthAlerts),
      matches: matches.map((match) => ({
        id: match.id,
        bracketId: match.bracketId,
        status: match.status,
        pauseReason: match.pauseReason,
      })),
    };
  }
}
