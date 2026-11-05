import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  ForbiddenException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { PassportService } from './passport.service';
import { CreatePassportDto } from './dto/create-passport.dto';
import { UpdatePassportDto } from './dto/update-passport.dto';
import { AddSportRecordDto } from './dto/add-sport-record.dto';
import { AthletePassportDto } from './dto/passport-response.dto';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { ApiCursorQuery } from '../../common/decorators/api-cursor-query.decorator';
import { JwtAuthGuard, AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { UserRole } from '@prisma/client';

@ApiTags('Digital Sports Passport')
@Controller('passport')
export class PassportController {
  constructor(private readonly passportService: PassportService) {}

  @Get(':userId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Retrieve Digital Sports Passport',
    description:
      'Returns cross-sport performance logs, earned badges, composite GTI, and verified physical stats for the specified athlete.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Digital Sports Passport returned successfully',
    type: AthletePassportDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Passport not found',
  })
  async getPassport(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<AthletePassportDto> {
    const privilegedRoles: readonly string[] = [
      UserRole.SCOUT,
      UserRole.FEDERATION_ADMIN,
      UserRole.SUPER_ADMIN,
    ];
    if (user.sub !== userId && !privilegedRoles.includes(user.role)) {
      throw new ForbiddenException("You cannot view another athlete's passport.");
    }
    return this.passportService.getPassportByUserId(userId, user);
  }

  @Post(':userId')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create athlete passport profile',
    description: 'Initializes a new Digital Sports Passport for an authenticated user.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key (min 16 chars) to prevent duplicate submissions',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Passport created',
    type: AthletePassportDto,
  })
  async createPassport(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: CreatePassportDto,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<AthletePassportDto> {
    if (user.sub !== userId && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You can only create your own athlete passport.');
    }
    return this.passportService.createPassport(userId, dto);
  }

  @Patch(':userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update basic profile metadata & verified physical stats',
    description:
      'Updates bio, physical stats (height, weight, dominant side), district, and state.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Idempotency key for state-altering requests over flaky mobile networks',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Passport updated',
    type: AthletePassportDto,
  })
  async updatePassport(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdatePassportDto,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<AthletePassportDto> {
    if (user.sub !== userId && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You can only update your own athlete passport.');
    }
    return this.passportService.updatePassport(userId, dto);
  }

  @Post(':userId/sports')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Add or update multi-sport athlete record',
    description: 'Attaches cross-sport performance logs, badges, or roles to the athlete passport.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Idempotency key for state-altering requests over flaky mobile networks',
  })
  async addSportRecord(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AddSportRecordDto,
    @CurrentUser() user: AuthenticatedJwtUser,
  ) {
    if (user.sub !== userId && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You can only update sports for your own passport.');
    }
    return this.passportService.addOrUpdateSportRecord(
      userId,
      dto,
      user.role === UserRole.SUPER_ADMIN,
    );
  }

  @Get(':userId/sports')
  @UseGuards(JwtAuthGuard)
  @ApiCursorQuery()
  @ApiOperation({
    summary: 'List cross-sport records with cursor-based pagination',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Paginated sport records',
  })
  async listSportRecords(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: CursorPaginationQueryDto,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<PaginatedResponseDto<unknown>> {
    const allowedRoles: readonly string[] = [
      UserRole.SCOUT,
      UserRole.FEDERATION_ADMIN,
      UserRole.SUPER_ADMIN,
    ];
    if (user.sub !== userId && !allowedRoles.includes(user.role))
      throw new ForbiddenException('You cannot view this passport.');
    await this.passportService.getPassportByUserId(userId, user);
    return this.passportService.listSportRecords(userId, query);
  }
}
