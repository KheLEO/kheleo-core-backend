import { IsString, IsNumber, IsOptional, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export class TelemetryWebhookDto {
  @IsString()
  athlete_id!: string;

  @IsOptional()
  @IsString()
  tournament_id?: string;

  @IsOptional()
  @IsString()
  bracket_id?: string;

  @IsOptional()
  @IsUUID()
  match_id?: string;

  @IsNumber()
  heart_rate!: number;

  @IsNumber()
  spo2!: number;

  @IsNumber()
  skin_temperature!: number;

  @Type(() => Number)
  @IsNumber()
  timestamp?: number;
}

export interface TelemetryResponseDto {
  readonly alert_triggered: boolean;
  readonly status: 'MATCH_PAUSED' | 'WARNING' | 'NORMAL';
  readonly message?: string;
}
