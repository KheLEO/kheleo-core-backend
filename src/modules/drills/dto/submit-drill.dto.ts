import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { SportType } from '@prisma/client';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';

export class SubmitDrillDto {
  @IsOptional()
  @IsUUID()
  @FieldAliases('athleteId')
  readonly athlete_id?: string;

  @IsEnum(SportType)
  readonly sport!: SportType;

  @IsString()
  @IsNotEmpty()
  readonly drill_type!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  readonly form_score!: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  readonly frames_analyzed!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  readonly flaw_flags?: string[];

  @IsOptional()
  @IsObject()
  readonly joint_angles_summary?: Record<string, unknown>;

  @IsNumber()
  @Min(1)
  readonly timestamp!: number;
}
