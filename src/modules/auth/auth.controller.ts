import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  SetMetadata,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { AuthService, GovernmentIdVerificationResponse } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyGovIdDto } from './dto/verify-gov-id.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard, AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  FRESH_IDEMPOTENCY_KEY,
  IdempotencyInterceptor,
} from '../../common/interceptors/idempotency.interceptor';

@ApiTags('Authentication & Identity')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @SetMetadata(FRESH_IDEMPOTENCY_KEY, true)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Register athlete profile with Anti-Account Reset check',
    description:
      'Creates a new User and AthleteProfile. If a Government ID is provided, it is irreversibly hashed (SHA-256 + salt + pepper) and verified. Duplicate accounts attempting to reset GTI are strictly rejected.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key (min 16 chars) to prevent duplicate submissions over flaky networks',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Registration successful, returns lightweight JWT tokens',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'Conflict — user already exists or Government ID is already bound to another profile',
  })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @SetMetadata(FRESH_IDEMPOTENCY_KEY, true)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Login via verified contact and Government ID proof',
    description:
      'Authenticates against the permanent identity ledger and returns lightweight access and refresh tokens.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Login successful',
    type: AuthResponseDto,
  })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Post(['verify-government-id', 'verify-gov-id'])
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bind and verify Government ID to profile (Anti-Account Reset enforcement)',
    description:
      'Hashes the government document (Aadhaar, Voter ID, Passport) and binds it uniquely to this user. Rejects if already linked to any previous profile.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Government ID bound and verified',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Anti-Account Reset Loophole triggered: ID already belongs to an existing athlete',
  })
  async verifyGovernmentId(
    @CurrentUser() user: AuthenticatedJwtUser,
    @Body() dto: VerifyGovIdDto,
  ): Promise<GovernmentIdVerificationResponse> {
    return this.authService.verifyGovernmentId(user.sub, dto);
  }

  @Post('refresh')
  @SetMetadata(FRESH_IDEMPOTENCY_KEY, true)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Rotate refresh token and get fresh lightweight access token',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Tokens rotated successfully',
    type: AuthResponseDto,
  })
  async refreshToken(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refreshTokens(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke all user refresh tokens' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Logged out successfully' })
  async logout(
    @CurrentUser() user: AuthenticatedJwtUser,
  ): Promise<{ success: boolean; message: string }> {
    return this.authService.logout(user.sub);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated token identity' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Token payload' })
  getProfile(@CurrentUser() user: AuthenticatedJwtUser): AuthenticatedJwtUser {
    return user;
  }
}
