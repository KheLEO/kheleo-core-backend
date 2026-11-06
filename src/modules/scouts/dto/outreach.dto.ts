import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';
export type OutreachAction = 'OFFER_TRIAL' | 'SPONSORSHIP_INQUIRY' | 'SHORTLIST_BOOKMARK';
export class OutreachDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @FieldAliases('scout_notes', 'scoutNotes')
  readonly notes?: string;
  @IsOptional()
  @IsIn(['OFFER_TRIAL', 'SPONSORSHIP_INQUIRY', 'SHORTLIST_BOOKMARK'])
  readonly actionType?: OutreachAction;
  @IsOptional() @IsString() @MaxLength(200) readonly organizationName?: string;
  @IsOptional()
  @IsIn(['TRIAL', 'SCHOLARSHIP'])
  @FieldAliases('outreach_type')
  readonly outreachType?: 'TRIAL' | 'SCHOLARSHIP';
}
