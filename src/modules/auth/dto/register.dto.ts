import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsArray,
  IsDateString,
  Min,
  Max,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Expose, plainToInstance, Transform, TransformFnParams, Type } from 'class-transformer';
import { GovIdType, SportType, TierClassification, UserRole } from '@prisma/client';
import { normalizeDominantSide } from '../../../common/constants/india-locations';

export class GovernmentIdInputDto {
  @ApiPropertyOptional({ enum: GovIdType, example: GovIdType.AADHAAR, default: GovIdType.AADHAAR })
  @IsOptional()
  @IsEnum(GovIdType)
  @Transform(
    ({ value }: TransformFnParams): unknown =>
      value === undefined || value === null ? GovIdType.AADHAAR : value,
    { toClassOnly: true },
  )
  readonly idType: GovIdType = GovIdType.AADHAAR;

  @ApiProperty({ example: '5421 8901 2345' })
  @IsString()
  @IsNotEmpty()
  readonly idNumber!: string;
}

export class InitialAthleteProfileDto {
  @ApiProperty({ example: '2005-06-15' })
  @IsDateString({ strict: true })
  readonly dateOfBirth!: string;

  @ApiProperty({ example: 'MALE' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  readonly gender!: string;

  @ApiProperty({ enum: SportType, example: SportType.CRICKET })
  @IsEnum(SportType)
  @IsNotEmpty()
  readonly primarySport!: SportType;

  @ApiPropertyOptional({ enum: SportType, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(SportType, { each: true })
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
  readonly tierClassification?: TierClassification;

  @ApiPropertyOptional({ example: 178.5 })
  @IsOptional()
  @IsNumber()
  @Min(30)
  @Max(260)
  readonly heightCm?: number;

  @ApiPropertyOptional({ example: 71.0 })
  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(350)
  readonly weightKg?: number;

  @ApiPropertyOptional({ example: 'RIGHT', enum: ['RIGHT', 'LEFT', 'BOTH', 'AMBIDEXTROUS'] })
  @IsOptional()
  @IsString()
  @Transform(({ value }: TransformFnParams) => normalizeDominantSide(value) ?? value, {
    toClassOnly: true,
  })
  readonly dominantSide?: string;

  @ApiPropertyOptional({ example: 25.3176 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  readonly locationLat?: number;

  @ApiPropertyOptional({ example: 82.9739 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  readonly locationLng?: number;
}

export class RegisterDto {
  @ApiPropertyOptional({
    description:
      'Supabase access token proving confirmed contact ownership; required in production',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  readonly identityAccessToken?: string;
  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid E.164 phone number',
  })
  readonly phone?: string;

  @ApiPropertyOptional({ example: 'athlete@kheleo.com' })
  @IsOptional()
  @IsEmail()
  readonly email?: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.ATHLETE })
  @IsOptional()
  @IsEnum(UserRole)
  readonly role?: UserRole;

  @ApiPropertyOptional({ description: 'Server-issued invitation required for SUPER_ADMIN signup' })
  @IsOptional()
  @IsString()
  @MinLength(16)
  readonly adminInviteCode?: string;

  @ApiPropertyOptional({ type: InitialAthleteProfileDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialAthleteProfileDto)
  readonly profile?: InitialAthleteProfileDto;

  @ApiPropertyOptional({ type: GovernmentIdInputDto })
  @Expose()
  @IsOptional()
  @ValidateNested()
  @Type(() => GovernmentIdInputDto)
  @Transform(
    ({ value, obj }: TransformFnParams) => {
      const source =
        value && typeof value === 'object' && !Array.isArray(value)
          ? value
          : obj?.idNumber
            ? {
                idNumber: obj.idNumber,
                idType: obj.idType ?? GovIdType.AADHAAR,
              }
            : value;
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        return plainToInstance(GovernmentIdInputDto, {
          ...source,
          idType: (source as { idType?: GovIdType }).idType ?? GovIdType.AADHAAR,
        });
      }
      return value;
    },
    { toClassOnly: true },
  )
  readonly governmentId?: GovernmentIdInputDto;

  @ApiPropertyOptional({ example: '5421 8901 2345' })
  @IsOptional()
  @IsString()
  readonly idNumber?: string;

  @ApiPropertyOptional({ enum: GovIdType, example: GovIdType.AADHAAR, default: GovIdType.AADHAAR })
  @IsOptional()
  @IsEnum(GovIdType)
  @Transform(
    ({ value }: TransformFnParams): unknown =>
      value === undefined || value === null ? GovIdType.AADHAAR : value,
    { toClassOnly: true },
  )
  readonly idType?: GovIdType;
}
