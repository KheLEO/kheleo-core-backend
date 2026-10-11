import { Controller, Post, Get, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { GtiService, GtiComputationResult } from './gti.service';

@Controller('gti')
export class GtiController {
  constructor(private readonly gtiService: GtiService) {}

  @Post('recalculate/:athleteId')
  @HttpCode(HttpStatus.OK)
  async recalculate(
    @Param('athleteId') athleteId: string,
  ): Promise<GtiComputationResult> {
    return this.gtiService.recalculateAthleteGti(athleteId);
  }

  @Get('rank/:sport/:athleteId')
  async getRank(
    @Param('sport') sport: string,
    @Param('athleteId') athleteId: string,
    @Query('district') district?: string,
  ): Promise<{ sport: string; athleteId: string; rank: number | null }> {
    const rank = await this.gtiService.getLeaderboardRank(sport, athleteId, district);
    return { sport, athleteId, rank };
  }
}
