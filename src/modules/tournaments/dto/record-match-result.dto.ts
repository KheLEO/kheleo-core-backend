import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsUUID,
} from 'class-validator';
export class RecordMatchResultDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  winnerAthleteIds!: string[];
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(60)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  participantAthleteIds!: string[];
  @IsOptional() @IsUUID() matchId?: string;
}
