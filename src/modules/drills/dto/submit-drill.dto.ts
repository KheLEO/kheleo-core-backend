import {
  IsString,
  IsNumber,
  IsInt,
  IsOptional,
  Min,
  Max,
} from 'class-validator';

export class SubmitDrillDto {
  @IsOptional()
  @IsString()
  athlete_id?: string;

  @IsString()
  sport!: string;

  @IsString()
  drill_type!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  form_score!: number;

  @IsInt()
  @Min(1)
  frames_analyzed!: number;

  @IsOptional()
  flaw_flags?: string[] | Record<string, unknown>;

  @IsOptional()
  joint_angles_summary?: Record<string, unknown>;

  @IsNumber()
  timestamp!: number;
}
