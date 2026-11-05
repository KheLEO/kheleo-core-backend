import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
  UseInterceptors,
  HttpCode,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedJwtUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { OrganizerService } from './organizer.service';

@Controller('tournaments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ORGANIZER, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
export class OrganizerController {
  constructor(private readonly service: OrganizerService) {}
  @Get('organizer/summary')
  summary(@CurrentUser() actor: AuthenticatedJwtUser) {
    return this.service.summary(actor);
  }
  @Get('organizer/mine')
  mine(@CurrentUser() actor: AuthenticatedJwtUser, @Query() query: CursorPaginationQueryDto) {
    return this.service.mine(actor, query);
  }
  @Get(':tournamentId/brackets/:bracketId/registrations')
  registrations(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.service.registrations(actor, tournamentId, bracketId, query);
  }
  @Get(':tournamentId/brackets/:bracketId/free-agents/pool')
  pool(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.service.pool(actor, tournamentId, bracketId, query);
  }
  @Post(':tournamentId/brackets/:bracketId/free-agents/process')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  process(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
  ) {
    return this.service.process(actor, tournamentId, bracketId);
  }
  @Get(':tournamentId/sandbagging-logs')
  logs(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.service.sandbaggingLogs(actor, tournamentId, query);
  }
}
