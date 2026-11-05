import {
  IsArray,
  IsString,
  MinLength,
  MaxLength,
  Equals,
  ArrayUnique,
  IsIn,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AlertSeverity } from '@prisma/client';

export class TelemetryWebhookDto {
  @IsUUID() athlete_id!: string;
  @IsOptional() @IsIn(['BLE', 'SIMULATOR']) source?: 'BLE' | 'SIMULATOR';
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(['spo2', 'skin_temperature'], { each: true })
  baseline_fields?: ('spo2' | 'skin_temperature')[];
  @IsOptional() @IsUUID() tournament_id?: string;
  @IsOptional() @IsUUID() bracket_id?: string;
  @IsOptional() @IsUUID() match_id?: string;
  @IsNumber() @Min(20) @Max(260) heart_rate!: number;
  @IsNumber() @Min(50) @Max(100) spo2!: number;
  @IsNumber() @Min(25) @Max(45) skin_temperature!: number;
  @IsNumber() @Min(1) timestamp!: number;
}

export class SafetyAlertsQueryDto {
  @IsOptional() @IsUUID() tournament_id?: string;
  @IsOptional() @IsUUID() bracket_id?: string;
  @IsOptional() @IsEnum(AlertSeverity) severity?: AlertSeverity;
  @IsOptional() @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export interface TelemetryResponseDto {
  readonly alert_triggered: boolean;
  readonly status: 'MATCH_PAUSED' | 'CRITICAL_ALERT' | 'WARNING' | 'NORMAL';
  readonly message?: string;
}

export class AcknowledgeSafetyDto {
  @IsString() @MinLength(5) @MaxLength(1000) medicalCheckNote!: string;
  @Equals(true) medicalCheckDispatched!: boolean;
}
export class ResumeSafetyDto {
  @Equals(true) medicalClearanceConfirmed!: boolean;
  @IsString() @MinLength(5) @MaxLength(1000) medicalClearanceNote!: string;
}
