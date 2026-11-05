import {
  Controller,
  Post,
  Patch,
  Delete,
  Get,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { BracketsService } from './brackets.service';
import { RegisterBracketDto } from './dto/register-bracket.dto';
import { CreateBracketDto } from './dto/create-bracket.dto';
import { BracketRegistrationResponseDto } from './dto/bracket-registration-response.dto';
import { JwtAuthGuard, AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { Bracket, UserRole } from '@prisma/client';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { UpdateBracketDto } from './dto/update-bracket.dto';

@ApiTags('Tournament Brackets & Anti-Sandbagging Gatekeeper')
@Controller()
export class BracketsController {
  constructor(private readonly bracketsService: BracketsService) {}

  @Post('tournaments/:tournamentId/brackets/:bracketId/register')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Register athlete for tournament bracket (Anti-Sandbagging Gatekeeper)',
    description:
      'Validates the athlete verified Grassroots Talent Index (GTI) against bracket skill ceiling. Rejects higher-skilled players with 409 SANDBAGGING_DETECTED error payload and suggests appropriate tier. Employs Redis Idempotency-Key locking to guard against flaky network retries.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique key (min 16 chars) to prevent duplicate submissions over flaky mobile networks',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Successfully registered for bracket',
    type: BracketRegistrationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SANDBAGGING_DETECTED: Athlete skill ceiling exceeded or capacity full',
  })
  async register(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @CurrentUser() user: AuthenticatedJwtUser,
    @Body() dto: RegisterBracketDto,
  ): Promise<BracketRegistrationResponseDto> {
    return this.bracketsService.registerForBracket(tournamentId, bracketId, user.sub, dto);
  }

  @Get('tournaments/:tournamentId/brackets')
  @ApiOperation({ summary: 'List all brackets for a tournament' })
  @ApiResponse({ status: HttpStatus.OK, description: 'List of brackets' })
  async findByTournament(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.bracketsService.findByTournament(tournamentId, query);
  }

  @Post('tournaments/:tournamentId/brackets')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create bracket in a tournament' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Bracket created' })
  async createBracket(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: CreateBracketDto,
    @CurrentUser() actor: AuthenticatedJwtUser,
  ): Promise<Bracket> {
    return this.bracketsService.createBracket(tournamentId, dto, actor);
  }

  @Patch('tournaments/:tournamentId/brackets/:bracketId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  async updateBracket(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @Body() dto: UpdateBracketDto,
    @CurrentUser() actor: AuthenticatedJwtUser,
  ): Promise<Bracket> {
    return this.bracketsService.updateBracket(tournamentId, bracketId, dto, actor);
  }

  @Delete('tournaments/:tournamentId/brackets/:bracketId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  async deleteBracket(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('bracketId', ParseUUIDPipe) bracketId: string,
    @CurrentUser() actor: AuthenticatedJwtUser,
  ): Promise<Bracket> {
    return this.bracketsService.deleteBracket(tournamentId, bracketId, actor);
  }
}
