import { Controller, Get, Patch, Query, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ScoutsService, ScoutFeedResponse } from './scouts.service';
import { ScoutFeedQueryDto } from './dto/scout-feed-query.dto';

@Controller('scouts')
export class ScoutsController {
  constructor(private readonly scoutsService: ScoutsService) {}

  @Get('feed')
  async getFeed(@Query() query: ScoutFeedQueryDto): Promise<ScoutFeedResponse> {
    return this.scoutsService.getScoutFeed(query);
  }

  @Get('alerts')
  async getAlerts(
    @Query('sport') sport?: string,
    @Query('district') district?: string,
  ) {
    return this.scoutsService.getAlerts(sport, district);
  }

  @Patch('alerts/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledgeAlert(@Param('id') id: string) {
    return this.scoutsService.acknowledgeAlert(id);
  }
}
