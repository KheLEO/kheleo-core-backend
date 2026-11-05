import {
  Controller,
  Get,
  Post,
  Body,
  ParseUUIDPipe,
  Patch,
  Query,
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
  async getAlerts(@Query('sport') sport?: string, @Query('district') district?: string) {
    return this.scoutsService.getAlerts(sport, district);
  }

  @Patch('alerts/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  async acknowledgeAlert(@Param('id') id: string) {
    return this.scoutsService.acknowledgeAlert(id);
  }
}
