import { Controller, Get } from '@nestjs/common';
import { HeatmapsService, RegionalHeatmapResponse } from './heatmaps.service';

@Controller('heatmaps')
export class HeatmapsController {
  constructor(private readonly heatmapsService: HeatmapsService) {}

  @Get('regional')
  async getRegional(): Promise<RegionalHeatmapResponse> {
    return this.heatmapsService.getRegionalHeatmap();
  }
}
