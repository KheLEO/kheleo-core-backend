import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  IsObject,
  MinLength,
  MaxLength,
  IsOptional,
  IsUUID,
} from 'class-validator';
export class RecordMatchResultDto {
  @IsOptional() @IsString() @MaxLength(150) matchName?: string;
  @IsOptional() @IsObject() scoreSummary?: Record<string, unknown>;
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

export class OrganizerMatchResultDto {
  @IsString() @MinLength(3) @MaxLength(150) matchName!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  winnerAthleteIds!: string[];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  loserAthleteIds!: string[];
  @IsObject() scoreSummary!: Record<string, unknown>;
  @IsOptional() @IsUUID() matchId?: string;
}
