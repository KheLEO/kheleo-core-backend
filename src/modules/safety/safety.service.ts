import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { WsEventGateway } from '../../infrastructure/realtime/ws-event.gateway';
import { TelemetryWebhookDto, TelemetryResponseDto } from './dto/telemetry-webhook.dto';
import { AlertSeverity } from '@prisma/client';

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wsGateway: WsEventGateway,
  ) {}

  async processTelemetry(dto: TelemetryWebhookDto): Promise<TelemetryResponseDto> {
    const { heart_rate, spo2, skin_temperature, athlete_id, tournament_id, bracket_id } = dto;

    // 1. Evaluate Critical Thresholds: HR > 195 OR SpO2 < 90% OR Temp > 39.5°C
    const isCritical =
      heart_rate > 195 ||
      spo2 < 90 ||
      skin_temperature > 39.5;

    // 2. Evaluate Warning Thresholds: HR > 185 OR SpO2 < 93% OR Temp > 38.5°C
    const isWarning =
      !isCritical &&
      (heart_rate > 185 ||
        spo2 < 93 ||
        skin_temperature > 38.5);

    if (isCritical) {
      const breachReasons: string[] = [];
      if (heart_rate > 195) breachReasons.push(`Heart Rate (${heart_rate} bpm > 195 bpm)`);
      if (spo2 < 90) breachReasons.push(`SpO2 (${spo2}% < 90%)`);
      if (skin_temperature > 39.5) breachReasons.push(`Skin Temp (${skin_temperature}°C > 39.5°C)`);
      const triggerReason = `CRITICAL BIOMETRIC EXTREME: ${breachReasons.join(', ')}`;

      // Resolve athlete name for umpire/organizer heads-up
      let athleteName = `Athlete ${athlete_id.slice(0, 8)}`;
      let targetUserId = athlete_id;

      try {
        const user = await this.prisma.user.findUnique({
          where: { id: athlete_id },
          include: { athleteProfile: true },
        });
        if (user) {
          targetUserId = user.id;
          athleteName = user.email || user.phone || athleteName;
        } else {
          const profile = await this.prisma.athleteProfile.findUnique({
            where: { id: athlete_id },
            include: { user: true },
          });
          if (profile) {
            targetUserId = profile.userId;
            athleteName = profile.user.email || profile.user.phone || athleteName;
          }
        }
      } catch (err) {
        this.logger.debug(`Could not resolve athlete name for ${athlete_id}: ${String(err)}`);
      }

      // Log entry in HealthAlert with match_paused = true
      await this.prisma.healthAlert.create({
        data: {
          athleteId: targetUserId,
          tournamentId: tournament_id || null,
          bracketId: bracket_id || null,
          severity: AlertSeverity.CRITICAL,
          heartRate: heart_rate,
          spo2,
          skinTemperature: skin_temperature,
          triggerReason,
          matchPaused: true,
        },
      });

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

      let targetUserId = athlete_id;
      try {
        const user = await this.prisma.user.findUnique({ where: { id: athlete_id } });
        if (user) targetUserId = user.id;
      } catch {
        // Fallback to athlete_id
      }

      await this.prisma.healthAlert.create({
        data: {
          athleteId: targetUserId,
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
}
