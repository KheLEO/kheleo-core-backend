import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Expose, plainToInstance, Transform, TransformFnParams, Type } from 'class-transformer';
import { GovIdType } from '@prisma/client';
import { GovernmentIdInputDto } from './register.dto';

export class LoginDto {
  @ApiPropertyOptional({
    description:
      'Supabase access token proving confirmed contact ownership; required in production',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  readonly identityAccessToken?: string;

  @ApiPropertyOptional({ example: 'athlete@kheleo.com' })
  @IsOptional()
  @IsString()
  readonly identifier?: string;

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

  @ApiPropertyOptional({ example: 'SecurePassword123' })
  @IsOptional()
  @IsString()
  readonly password?: string;

  @ApiPropertyOptional({ type: GovernmentIdInputDto })
  @Expose()
  @ValidateIf((o: LoginDto) => o.governmentId !== undefined && o.governmentId !== null)
  @IsNotEmptyObject()
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
