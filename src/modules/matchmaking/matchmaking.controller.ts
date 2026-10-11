import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { MatchmakingService } from './matchmaking.service';
import { JoinFreeAgentDto } from './dto/join-free-agent.dto';
import { FreeAgentStatusResponseDto } from './dto/free-agent-status-response.dto';
import { JwtAuthGuard, AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Dynamic Free Agent Matchmaking Pool')
@Controller('tournaments/:tournamentId/brackets/:bracketId/free-agents')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MatchmakingController {
  constructor(private readonly matchmakingService: MatchmakingService) {}

  @Post('join')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Join dynamic free agent matchmaking pool',
    description:
      'Enqueues an unattached athlete into the complementary role matchmaking pool. Runs Anti-Sandbagging GTI gatekeeper validation, prevents duplicate team registrations, and triggers the BullMQ role-balancing worker.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Successfully joined the matchmaking pool',
    type: FreeAgentStatusResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SANDBAGGING_DETECTED: Athlete skill ceiling exceeded, or already queued in tournament',
  })
  async joinPool(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @CurrentUser() user: AuthenticatedJwtUser,
    @Body() dto: JoinFreeAgentDto,
  ): Promise<FreeAgentStatusResponseDto> {
    return this.matchmakingService.joinPool(
      tournamentId,
      bracketId,
      user.sub,
      dto,
    );
  }

  @Delete('leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exit free agent queue before matching',
    description:
      'Allows an athlete to cancel and exit the queue if their status is still QUEUED.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Successfully removed from the pool',
  })
  async leavePool(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<{ message: string; cancelled: boolean }> {
    return this.matchmakingService.leavePool(tournamentId, bracketId, user.sub);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get free agent queue status & roster details',
    description:
      'Returns current wait position in FIFO queue, or if already matched, returns formed team ID and assigned complementary roster.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Queue status retrieved',
    type: FreeAgentStatusResponseDto,
  })
  async getStatus(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<FreeAgentStatusResponseDto> {
    return this.matchmakingService.getQueueStatus(
      tournamentId,
      bracketId,
      user.sub,
    );
  }
}
