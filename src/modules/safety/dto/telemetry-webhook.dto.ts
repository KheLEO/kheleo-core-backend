import { IsString, IsNumber, IsOptional } from 'class-validator';

export class TelemetryWebhookDto {
  @IsString()
  athlete_id!: string;

  @IsOptional()
  @IsString()
  tournament_id?: string;

  @IsOptional()
  @IsString()
  bracket_id?: string;

  @IsNumber()
  heart_rate!: number;

  @IsNumber()
  spo2!: number;

  @IsNumber()
  skin_temperature!: number;

  @IsOptional()
  timestamp?: number | string;
}

export interface TelemetryResponseDto {
  readonly alert_triggered: boolean;
  readonly status: 'MATCH_PAUSED' | 'WARNING' | 'NORMAL';
  readonly message?: string;
}
