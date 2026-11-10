import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { GovIdType } from '@prisma/client';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';
import { GovernmentIdInputDto } from './register.dto';

export class VerifyGovIdDto {
  @ApiPropertyOptional({
    description: 'Government ID document type',
    enum: GovIdType,
    example: GovIdType.AADHAAR,
    default: GovIdType.AADHAAR,
  })
  @IsOptional()
  @IsEnum(GovIdType)
  @FieldAliases('id_type')
  @Transform(
    ({ value, obj }: TransformFnParams): unknown => {
      if (value !== undefined && value !== null) return value;
      const nestedGovId = (obj as { governmentId?: { idType?: GovIdType; id_type?: GovIdType } })
        ?.governmentId;
      if (nestedGovId && typeof nestedGovId === 'object') {
        const nestedType = nestedGovId.idType ?? nestedGovId.id_type;
        if (nestedType !== undefined && nestedType !== null) return nestedType;
      }
      return GovIdType.AADHAAR;
    },
    { toClassOnly: true },
  )
  readonly idType: GovIdType = GovIdType.AADHAAR;

  @ApiPropertyOptional({
    description: 'Raw government ID number (hashed irreversibly before DB storage)',
    example: '5421 8901 2345',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @FieldAliases('id_number', 'gov_id')
  @Transform(
    ({ value, obj }: TransformFnParams): unknown => {
      if (value !== undefined && value !== null) return value;
      const nestedGovId = (
        obj as {
          governmentId?: {
            idNumber?: string;
            id_number?: string;
            gov_id?: string;
          };
        }
      )?.governmentId;
      if (nestedGovId && typeof nestedGovId === 'object') {
        const nestedNumber =
          nestedGovId.idNumber ?? nestedGovId.id_number ?? nestedGovId.gov_id;
        if (nestedNumber !== undefined && nestedNumber !== null) return nestedNumber;
      }
      return value;
    },
    { toClassOnly: true },
  )
  readonly idNumber!: string;

  @ApiPropertyOptional({ type: GovernmentIdInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GovernmentIdInputDto)
  readonly governmentId?: GovernmentIdInputDto;
}
