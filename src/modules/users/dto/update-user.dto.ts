import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateUserDto {
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
}
