import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';

export class OutreachDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  @FieldAliases('scout_notes', 'scoutNotes')
  readonly notes!: string;

  @ApiPropertyOptional({ enum: ['TRIAL', 'SCHOLARSHIP'] })
  @IsOptional()
  @IsIn(['TRIAL', 'SCHOLARSHIP'])
  @FieldAliases('outreach_type')
  readonly outreachType?: 'TRIAL' | 'SCHOLARSHIP';
}
