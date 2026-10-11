import {
  Controller,
  Get,
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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';

@Controller('scouts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SCOUT, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
export class ScoutsController {
  constructor(private readonly scoutsService: ScoutsService) {}

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
