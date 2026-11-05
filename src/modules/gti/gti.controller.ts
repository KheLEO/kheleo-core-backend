import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  ForbiddenException,
  ParseUUIDPipe,
  ParseEnumPipe,
} from '@nestjs/common';
import { GtiService, GtiComputationResult } from './gti.service';
import { AuthenticatedJwtUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SportType, UserRole } from '@prisma/client';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';

import { LeaderboardPage, LeaderboardsQueryDto } from '../leaderboards/leaderboards.dto';

@Controller('gti')
export class GtiController {
  constructor(private readonly gtiService: GtiService) {}

  @Post('recalculate/:athleteId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async recalculate(
    @Param('athleteId', ParseUUIDPipe) athleteId: string,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<GtiComputationResult> {
    const privilegedRoles: readonly string[] = [UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN];
    if (user.sub !== athleteId && !privilegedRoles.includes(user.role)) {
      throw new ForbiddenException("You cannot recalculate another athlete's GTI.");
    }
    return this.gtiService.recalculateAthleteGti(athleteId);
  }

  @Get('leaderboards')
  async leaderboards(@Query() query: LeaderboardsQueryDto): Promise<LeaderboardPage> {
    return this.gtiService.getLeaderboards(query);
  }

  @Get('rank/:sport/:athleteId')
  async getRank(
    @Param('sport', new ParseEnumPipe(SportType)) sport: SportType,
    @Param('athleteId', ParseUUIDPipe) athleteId: string,
    @Query('district') district?: string,
  ): Promise<{ sport: string; athleteId: string; rank: number | null }> {
    const rank = await this.gtiService.getLeaderboardRank(sport, athleteId, district);
    return { sport, athleteId, rank };
  }
}
