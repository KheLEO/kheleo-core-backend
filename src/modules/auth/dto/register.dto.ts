import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GovIdType, SportType, TierClassification, UserRole } from '@prisma/client';

export class GovernmentIdInputDto {
  @ApiProperty({ enum: GovIdType, example: GovIdType.AADHAAR })
  @IsEnum(GovIdType)
  @IsNotEmpty()
  readonly idType!: GovIdType;

  @ApiProperty({ example: '5421 8901 2345' })
  @IsString()
  @IsNotEmpty()
  readonly idNumber!: string;
}

export class InitialAthleteProfileDto {
  @ApiProperty({ example: '2005-06-15' })
  @IsString()
  @IsNotEmpty()
  readonly dateOfBirth!: string;

  @ApiProperty({ example: 'MALE' })
  @IsString()
  @IsNotEmpty()
  readonly gender!: string;

  @ApiProperty({ enum: SportType, example: SportType.CRICKET })
  @IsEnum(SportType)
  @IsNotEmpty()
  readonly primarySport!: SportType;

  @ApiPropertyOptional({ enum: SportType, isArray: true })
  @IsOptional()
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
  readonly heightCm?: number;

  @ApiPropertyOptional({ example: 71.0 })
  @IsOptional()
  @IsNumber()
  readonly weightKg?: number;

  @ApiPropertyOptional({ example: 'RIGHT' })
  @IsOptional()
  @IsString()
  readonly dominantSide?: string;
}

export class RegisterDto {
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

  @ApiPropertyOptional({ type: InitialAthleteProfileDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialAthleteProfileDto)
  readonly profile?: InitialAthleteProfileDto;

  @ApiPropertyOptional({ type: GovernmentIdInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GovernmentIdInputDto)
  readonly governmentId?: GovernmentIdInputDto;
}
