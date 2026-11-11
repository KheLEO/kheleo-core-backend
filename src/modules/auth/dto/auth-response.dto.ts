import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole, VerificationStatus } from '@prisma/client';

export class AuthUserSummaryDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  readonly id!: string;

  @ApiPropertyOptional({ example: 'Ravi Kumar', nullable: true })
  readonly name?: string | null;

  @ApiProperty({ example: '+919876543210', nullable: true })
  readonly phone!: string | null;

  @ApiProperty({ example: 'athlete@kheleo.com', nullable: true })
  readonly email!: string | null;

  @ApiProperty({ enum: UserRole, example: UserRole.ATHLETE })
  readonly role!: UserRole;

  @ApiProperty({ example: true })
  readonly isVerified!: boolean;

  @ApiProperty({ example: true })
  readonly isLegit!: boolean;

  @ApiProperty({
    enum: VerificationStatus,
    example: VerificationStatus.UNVERIFIED,
  })
  readonly identityStatus!: VerificationStatus | 'VERIFIED' | 'UNVERIFIED' | 'FLAGGED_DUPLICATE' | 'REVOKED';

  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174001',
    nullable: true,
  })
  readonly athleteProfileId!: string | null;
}

export class AuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...' })
  readonly accessToken!: string;

  @ApiProperty({ example: '7d_refresh_token_uuid_or_jwt' })
  readonly refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  readonly tokenType: string = 'Bearer';

  @ApiProperty({ example: 900, description: 'Expiry in seconds (15 minutes)' })
  readonly expiresIn!: number;

  @ApiProperty({ type: AuthUserSummaryDto })
  readonly user!: AuthUserSummaryDto;
}
