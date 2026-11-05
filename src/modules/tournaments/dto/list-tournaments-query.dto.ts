import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { SportType, TournamentStatus } from '@prisma/client';
import { CursorPaginationQueryDto } from '../../../common/dto/cursor-pagination-query.dto';
import { FieldAliases } from '../../../common/decorators/field-aliases.decorator';

export class ListTournamentsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: SportType })
  @IsOptional()
  @IsEnum(SportType)
  readonly sport?: SportType;

  @ApiPropertyOptional({ enum: TournamentStatus })
  @IsOptional()
  @IsEnum(TournamentStatus)
  readonly status?: TournamentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  @FieldAliases('organizerId')
  readonly organizer_id?: string;
}
