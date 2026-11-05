import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { HealthAlert, Match, UserRole } from '@prisma/client';
import { SafetyService } from './safety.service';
import {
  SafetyAlertsQueryDto,
  AcknowledgeSafetyDto,
  ResumeSafetyDto,
  TelemetryResponseDto,
  TelemetryWebhookDto,
} from './dto/telemetry-webhook.dto';
import { TelemetryAuthGuard, TelemetryRequest } from './telemetry-auth.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { AuthenticatedJwtUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { CursorPage } from '../../common/dto/cursor-page';

@Controller('safety')
export class SafetyController {
  constructor(private readonly service: SafetyService) {}
  @Post('telemetry-webhook')
  @HttpCode(200)
  @UseGuards(TelemetryAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async telemetry(
    @Body() dto: TelemetryWebhookDto,
    @Req() request: TelemetryRequest,
  ): Promise<TelemetryResponseDto> {
    return this.service.processTelemetry(dto, request.telemetrySource);
  }

  @Get('alerts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.UMPIRE, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  async alerts(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Query() query: SafetyAlertsQueryDto,
  ): Promise<CursorPage<HealthAlert>> {
    return this.service.listAlerts(actor, query);
  }

  @Patch('alerts/:id/acknowledge')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.UMPIRE, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async acknowledge(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcknowledgeSafetyDto,
  ): Promise<HealthAlert> {
    return this.service.acknowledge(actor, id, dto);
  }

  @Post('matches/:matchId/resume')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.UMPIRE, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async resume(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('matchId', ParseUUIDPipe) id: string,
    @Body() dto: ResumeSafetyDto,
  ): Promise<Match> {
    return this.service.resume(actor, id, dto);
  }
  @Get('tournaments/:tournamentId/vitals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  vitals(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.service.tournamentVitals(actor, tournamentId, query);
  }
  @Get('tournaments/:tournamentId/alerts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  history(
    @CurrentUser() actor: AuthenticatedJwtUser,
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.service.tournamentAlerts(actor, tournamentId, query);
  }
}
