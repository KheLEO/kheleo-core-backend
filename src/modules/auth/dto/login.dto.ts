import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDefined,
  IsEmail,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GovernmentIdInputDto } from './register.dto';

export class LoginDto {
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

  @ApiProperty({ type: GovernmentIdInputDto })
  @IsDefined()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => GovernmentIdInputDto)
  readonly governmentId!: GovernmentIdInputDto;
}
