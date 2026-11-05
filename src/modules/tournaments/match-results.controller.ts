import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { UserRole, VerifiedMatchResult } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedJwtUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { RecordMatchResultDto } from './dto/record-match-result.dto';
import { MatchResultsService } from './match-results.service';

@Controller('tournaments/:tournamentId/brackets/:bracketId/matches')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ORGANIZER, UserRole.UMPIRE, UserRole.SUPER_ADMIN)
export class MatchResultsController {
  constructor(private readonly service: MatchResultsService) {}
  @Post('record-result')
  @UseInterceptors(IdempotencyInterceptor)
  async record(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Body() dto: RecordMatchResultDto,
    @Headers('idempotency-key') key: string,
  ): Promise<VerifiedMatchResult> {
    return this.service.recordResult(tournamentId, bracketId, actor, dto, key);
  }
}
