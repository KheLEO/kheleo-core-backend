import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { GovIdType } from '@prisma/client';
import { Transform, TransformFnParams } from 'class-transformer';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';

export class VerifyGovIdDto {
  @ApiProperty({
    description: 'Government ID document type',
    enum: GovIdType,
    example: GovIdType.AADHAAR,
  })
  @IsEnum(GovIdType)
  @IsNotEmpty()
  @FieldAliases('id_type')
  @Transform(
    ({ value }: TransformFnParams): unknown => (value === undefined ? GovIdType.AADHAAR : value),
    { toClassOnly: true },
  )
  readonly idType!: GovIdType;

  @ApiProperty({
    description: 'Raw government ID number (hashed irreversibly before DB storage)',
    example: '5421 8901 2345',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @FieldAliases('id_number', 'gov_id')
  readonly idNumber!: string;
}
