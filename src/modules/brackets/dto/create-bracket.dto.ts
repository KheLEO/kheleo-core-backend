import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { BracketType } from '@prisma/client';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';

export class CreateBracketDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  readonly name!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @FieldAliases('tier_name')
  readonly tierName!: string;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @FieldAliases('min_gti')
  readonly minGti!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @FieldAliases('max_gti')
  readonly maxGti!: number;

  @ApiPropertyOptional({ minimum: 0 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(0)
  @FieldAliases('entry_fee')
  readonly entryFee?: number;

  @ApiPropertyOptional({ minimum: 2 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsInt()
  @Min(2)
  @FieldAliases('max_teams')
  readonly maxTeams?: number;

  @ApiPropertyOptional({ enum: BracketType })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsEnum(BracketType)
  @FieldAliases('bracket_type')
  readonly bracketType?: BracketType;
}
