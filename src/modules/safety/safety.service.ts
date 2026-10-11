import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { WsEventGateway } from '../../infrastructure/realtime/ws-event.gateway';
import { TelemetryWebhookDto, TelemetryResponseDto } from './dto/telemetry-webhook.dto';
import { AlertSeverity, MatchStatus } from '@prisma/client';

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wsGateway: WsEventGateway,
  ) {}

  async processTelemetry(dto: TelemetryWebhookDto): Promise<TelemetryResponseDto> {
    const { heart_rate, spo2, skin_temperature, athlete_id, tournament_id, bracket_id, match_id } =
      dto;

    // 1. Evaluate Critical Thresholds: HR > 195 OR SpO2 < 90% OR Temp > 39.5°C
    const isCritical = heart_rate > 195 || spo2 < 90 || skin_temperature > 39.5;

    // 2. Evaluate Warning Thresholds: HR > 185 OR SpO2 < 93% OR Temp > 38.5°C
    const isWarning = !isCritical && (heart_rate > 185 || spo2 < 93 || skin_temperature > 38.5);

    if (isCritical) {
      const breachReasons: string[] = [];
      if (heart_rate > 195) breachReasons.push(`Heart Rate (${heart_rate} bpm > 195 bpm)`);
      if (spo2 < 90) breachReasons.push(`SpO2 (${spo2}% < 90%)`);
      if (skin_temperature > 39.5) breachReasons.push(`Skin Temp (${skin_temperature}°C > 39.5°C)`);
      const triggerReason = `CRITICAL BIOMETRIC EXTREME: ${breachReasons.join(', ')}`;

      // Resolve athlete name for umpire/organizer heads-up
      const athlete = await this.resolveAthlete(athlete_id);
      const athleteName = athlete.email || athlete.phone || `Athlete ${athlete_id.slice(0, 8)}`;

      // Log entry in HealthAlert with match_paused = true
      const alertData = {
        athleteId: athlete.userId,
        tournamentId: tournament_id || null,
        bracketId: bracket_id || null,
        severity: AlertSeverity.CRITICAL,
        heartRate: heart_rate,
        spo2,
        skinTemperature: skin_temperature,
        triggerReason,
        matchPaused: true,
      };

      if (match_id) {
        await this.prisma.$transaction(async (transaction) => {
          const match = await transaction.match.findUnique({
            where: { id: match_id },
            select: {
              bracketId: true,
              status: true,
              bracket: { select: { tournamentId: true } },
            },
          });
          const pausableStatuses: readonly MatchStatus[] = [MatchStatus.WARMUP, MatchStatus.LIVE];
          if (
            !match ||
            (bracket_id !== undefined && match.bracketId !== bracket_id) ||
            (tournament_id !== undefined && match.bracket.tournamentId !== tournament_id) ||
            !pausableStatuses.includes(match.status)
          ) {
            throw new NotFoundException(
              'Telemetry match context does not match an active tournament match.',
            );
          }
          await transaction.match.update({
            where: { id: match_id },
            data: {
              status: MatchStatus.PAUSED_SAFETY,
              pauseReason: triggerReason,
              pausedAt: new Date(),
            },
          });
          await transaction.healthAlert.create({ data: alertData });
        });
      } else {
        await this.prisma.healthAlert.create({ data: alertData });
      }

      // Instantly broadcast MATCH_PAUSE_ALERT WebSocket event
      this.wsGateway.broadcastAutonomousMatchPause({
        event: 'MATCH_PAUSE_ALERT',
        severity: 'CRITICAL',
        athlete_id,
        athlete_name: athleteName,
        vitals: {
          heart_rate,
          spo2,
          skin_temperature,
        },
        directive: 'MANDATORY REST: PAUSE TOURNAMENT MATCH IMMEDIATELY',
        tournament_id,
        bracket_id,
        match_id,
      });

      this.logger.error(
        `AUTONOMOUS MATCH PAUSE TRIGGERED: Athlete=${athlete_id}, HR=${heart_rate}, SpO2=${spo2}, Temp=${skin_temperature}`,
      );

      return {
        alert_triggered: true,
        status: 'MATCH_PAUSED',
        message: 'MANDATORY REST: PAUSE TOURNAMENT MATCH IMMEDIATELY',
      };
    }

    if (isWarning) {
      const breachReasons: string[] = [];
      if (heart_rate > 185) breachReasons.push(`Heart Rate (${heart_rate} bpm > 185 bpm)`);
      if (spo2 < 93) breachReasons.push(`SpO2 (${spo2}% < 93%)`);
      if (skin_temperature > 38.5) breachReasons.push(`Skin Temp (${skin_temperature}°C > 38.5°C)`);
      const triggerReason = `WARNING BIOMETRIC ELEVATION: ${breachReasons.join(', ')}`;

      const athlete = await this.resolveAthlete(athlete_id);

      await this.prisma.healthAlert.create({
        data: {
          athleteId: athlete.userId,
          tournamentId: tournament_id || null,
          bracketId: bracket_id || null,
          severity: AlertSeverity.WARNING,
          heartRate: heart_rate,
          spo2,
          skinTemperature: skin_temperature,
          triggerReason,
          matchPaused: false,
        },
      });

      this.logger.warn(`Telemetry Warning: Athlete=${athlete_id}, Reason=${triggerReason}`);

      return {
        alert_triggered: true,
        status: 'WARNING',
        message: triggerReason,
      };
    }

    return {
      alert_triggered: false,
      status: 'NORMAL',
    };
  }

  private async resolveAthlete(
    athleteId: string,
  ): Promise<{ userId: string; email: string | null; phone: string | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: athleteId },
      select: { id: true, email: true, phone: true },
    });
    if (user) {
      return { userId: user.id, email: user.email, phone: user.phone };
    }

    const profile = await this.prisma.athleteProfile.findUnique({
      where: { id: athleteId },
      select: {
        userId: true,
        user: { select: { email: true, phone: true } },
      },
    });
    if (!profile) {
      throw new NotFoundException(`Athlete ${athleteId} was not found.`);
    }
    return {
      userId: profile.userId,
      email: profile.user.email,
      phone: profile.user.phone,
    };
  }
}
