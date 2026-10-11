import {
  Controller,
  Get,
  Post,
  Param,
  Query,
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
import { TournamentsService } from './tournaments.service';
import { NearbyTournamentsQueryDto } from './dto/nearby-tournaments-query.dto';
import { TournamentLocationDto } from './dto/tournament-location.dto';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { JwtAuthGuard, AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@ApiTags('Tournaments & Geospatial Discovery')
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournamentsService: TournamentsService) {}

  @Get('nearby')
  @ApiOperation({
    summary: 'Geospatial tournament discovery (PostGIS ST_DWithin)',
    description:
      'Queries active tournaments within requested radius (km) using PostGIS ST_DWithin and ST_MakePoint. Strips relational joins and returns flat DTOs optimized for mobile networks.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Flat array of nearby tournament locations',
    type: [TournamentLocationDto],
  })
  async findNearby(
    @Query() query: NearbyTournamentsQueryDto,
  ): Promise<readonly TournamentLocationDto[]> {
    return this.tournamentsService.findNearby(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve tournament details by ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Tournament found' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Tournament not found' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentsService.findById(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER, UserRole.FEDERATION_ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new tournament' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Tournament created' })
  async create(
    @CurrentUser() user: AuthenticatedJwtUser,
    @Body() dto: CreateTournamentDto,
  ) {
    return this.tournamentsService.create(user.sub, dto);
  }
}
