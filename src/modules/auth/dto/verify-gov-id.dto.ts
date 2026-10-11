import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { GovIdType } from '@prisma/client';

export class VerifyGovIdDto {
  @ApiProperty({
    description: 'Government ID document type',
    enum: GovIdType,
    example: GovIdType.AADHAAR,
  })
  @IsEnum(GovIdType)
  @IsNotEmpty()
  readonly idType!: GovIdType;

  @ApiProperty({
    description: 'Raw government ID number (hashed irreversibly before DB storage)',
    example: '5421 8901 2345',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  readonly idNumber!: string;
}
