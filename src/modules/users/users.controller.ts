import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard, AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { PassportService } from '../passport/passport.service';
import { UpdatePassportDto } from '../passport/dto/update-passport.dto';
import { AthletePassportDto } from '../passport/dto/passport-response.dto';
import { ScoutsDossiersService, AthleteDossierResponse } from '../scouts/dossiers.service';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly passports: PassportService,
    private readonly dossiers: ScoutsDossiersService,
  ) {}

  @Get('profile')
  async getProfile(@CurrentUser() user: AuthenticatedJwtUser): Promise<AthletePassportDto> {
    return this.passports.getOrCreatePassport(user.sub);
  }

  @Post('profile')
  @UseInterceptors(IdempotencyInterceptor)
  async upsertProfile(
    @CurrentUser() user: AuthenticatedJwtUser,
    @Body() dto: UpdatePassportDto,
  ): Promise<AthletePassportDto> {
    return this.passports.upsertPassport(user.sub, dto);
  }

  @Patch('profile')
  @UseInterceptors(IdempotencyInterceptor)
  async updateProfile(
    @CurrentUser() user: AuthenticatedJwtUser,
    @Body() dto: UpdatePassportDto,
  ): Promise<AthletePassportDto> {
    return this.passports.upsertPassport(user.sub, dto);
  }

  @Get(':id/dossier')
  async getDossier(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<AthleteDossierResponse> {
    return this.dossiers.getDossier(id, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user profile by user ID' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedJwtUser,
  ) {
    if (user.sub !== id && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You can only view your own user details.');
    }
    return this.usersService.findById(id);
  }

  @Patch(':id')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Update user contact details' })
  @ApiResponse({ status: 200, description: 'User updated' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedJwtUser,
  ) {
    if (user.sub !== id && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You can only update your own user details.');
    }
    return this.usersService.update(id, dto);
  }

  @Delete(':id')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Deactivate user account' })
  @ApiResponse({ status: 200, description: 'User deactivated' })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedJwtUser,
  ) {
    if (user.sub !== id && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You can only deactivate your own user account.');
    }
    return this.usersService.deactivate(id);
  }
}
