import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsArray,
  ArrayMaxSize,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SportType, TierClassification } from '@prisma/client';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  FieldAliases,
  NestedArrayAliases,
} from '../../../common/decorators/field-aliases.decorator';
import { normalizeDominantSide } from '../../../common/constants/india-locations';

export class PassportSportInputDto {
  @ApiProperty({ enum: SportType })
  @IsEnum(SportType)
  readonly sport!: SportType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @FieldAliases('primary_role')
  readonly primaryRole!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @FieldAliases('secondary_roles')
  readonly secondaryRoles?: string[];
}

export class CreatePassportDto {
  @ApiProperty({
    example: '2005-04-12',
    description: 'ISO format date of birth',
  })
  @IsDateString()
  @IsNotEmpty()
  @FieldAliases('date_of_birth')
  readonly dateOfBirth!: string;

  @ApiProperty({ example: 'MALE' })
  @IsString()
  @IsNotEmpty()
  readonly gender!: string;

  @ApiProperty({ enum: SportType, example: SportType.CRICKET })
  @IsEnum(SportType)
  @IsNotEmpty()
  @FieldAliases('primary_sport')
  readonly primarySport!: SportType;

  @ApiPropertyOptional({ enum: SportType, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(SportType, { each: true })
  @FieldAliases('secondary_sports')
  readonly secondarySports?: SportType[];

  @ApiProperty({ example: 'Varanasi' })
  @IsString()
  @IsNotEmpty()
  readonly district!: string;

  @ApiProperty({ example: 'Uttar Pradesh' })
  @IsString()
  @IsNotEmpty()
  readonly state!: string;

  @ApiPropertyOptional({
    enum: TierClassification,
    default: TierClassification.RURAL,
  })
  @IsOptional()
  @IsEnum(TierClassification)
  @FieldAliases('tier_classification')
  readonly tierClassification?: TierClassification;

  @ApiPropertyOptional({ example: 178.5, minimum: 50, maximum: 260 })
  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(260)
  @FieldAliases('height_cm')
  readonly heightCm?: number;

  @ApiPropertyOptional({ example: 72.0, minimum: 20, maximum: 200 })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(200)
  @FieldAliases('weight_kg')
  readonly weightKg?: number;

  @ApiPropertyOptional({ example: 'RIGHT', enum: ['RIGHT', 'LEFT', 'BOTH', 'AMBIDEXTROUS'] })
  @IsOptional()
  @IsString()
  @FieldAliases('dominant_side')
  @Transform(({ value }: TransformFnParams) => normalizeDominantSide(value) ?? value, {
    toClassOnly: true,
  })
  readonly dominantSide?: string;

  @ApiPropertyOptional({ example: 25.3176 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  @FieldAliases('location_lat')
  readonly locationLat?: number;

  @ApiPropertyOptional({ example: 82.9739 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  @FieldAliases('location_lng')
  readonly locationLng?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @FieldAliases('is_scout_searchable')
  readonly isScoutSearchable?: boolean;

  @ApiPropertyOptional({ type: [PassportSportInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => PassportSportInputDto)
  @NestedArrayAliases(PassportSportInputDto, 'sport_records')
  readonly sportRecords?: PassportSportInputDto[];
}
