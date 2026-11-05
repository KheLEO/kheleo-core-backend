import {
  Controller,
  Get,
  Post,
  Body,
  ParseUUIDPipe,
  Patch,
  Query,
  Res,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ScoutsService, ScoutFeedResponse } from './scouts.service';
import { ScoutFeedQueryDto } from './dto/scout-feed-query.dto';
import { JwtAuthGuard, AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ScoutDossier, UserRole } from '@prisma/client';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { ScoutsDossiersService } from './dossiers.service';
import { OutreachDto } from './dto/outreach.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScoutOutreachGuard } from './scout-outreach.guard';

import { FastifyReply } from 'fastify';
import { ScoutAlertsQueryDto } from './dto/scout-alerts-query.dto';

@Controller('scouts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SCOUT, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
export class ScoutsController {
  constructor(
    private readonly scoutsService: ScoutsService,
    private readonly dossiers: ScoutsDossiersService,
  ) {}

  @Post('dossiers/:athleteId/outreach')
  @UseGuards(ScoutOutreachGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async outreach(
    @Param('athleteId', ParseUUIDPipe) athleteId: string,
    @CurrentUser() viewer: AuthenticatedJwtUser,
    @Body() dto: OutreachDto,
  ): Promise<ScoutDossier> {
    return this.dossiers.outreach(athleteId, viewer, dto);
  }

  @Get('feed')
  async getFeed(@Query() query: ScoutFeedQueryDto): Promise<ScoutFeedResponse> {
    return this.scoutsService.getScoutFeed(query);
  }

  @Get('alerts')
  async getAlerts(
    @Query() query: ScoutAlertsQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const rows = await this.scoutsService.getAlerts(
      query.sport,
      query.district,
      query.cursor_id,
      query.limit,
    );
    const page = rows.slice(0, query.limit);
    if (rows.length > query.limit) void reply.header('X-Next-Cursor', page.at(-1)!.id);
    return page;
  }

  @Patch('alerts/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  async acknowledgeAlert(@Param('id', ParseUUIDPipe) id: string) {
    return this.scoutsService.acknowledgeAlert(id);
  }
}
