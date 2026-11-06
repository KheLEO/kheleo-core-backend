import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { IdentityService } from '../identity/identity.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyGovIdDto } from './dto/verify-gov-id.dto';
import { AuthResponseDto, AuthUserSummaryDto } from './dto/auth-response.dto';
import { GovIdType, Prisma, UserRole, VerificationStatus } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'node:crypto';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { assertAccountAccess, assertIdentityAccess } from '../../common/auth/account-access';
import { loadLocalJwtKeys, tokenDurationSeconds } from './jwt-keys';

import { verifyContactProof } from './contact-proof';

export interface GovernmentIdVerificationResponse {
  readonly message: string;
  readonly verified: boolean;
  readonly idHashPrefix: string;
  readonly userId: string;
  readonly athleteProfileId: string | null;
  readonly currentGti: number | null;
  readonly auth?: AuthResponseDto;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly privateKey: string;
  private readonly algorithm: jwt.Algorithm;
  private readonly accessExpirySeconds: number;
  private readonly refreshExpirySeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly identityService: IdentityService,
    private readonly configService: ConfigService,
  ) {
    const keys = loadLocalJwtKeys(configService);
    this.privateKey = keys.signingKey;
    this.algorithm = keys.algorithm;
    this.accessExpirySeconds = tokenDurationSeconds(
      configService.get<string | number>('auth.jwtAccessExpiry', '15m'),
      'JWT_ACCESS_EXPIRY',
    );
    this.refreshExpirySeconds = tokenDurationSeconds(
      configService.get<string | number>('auth.jwtRefreshExpiry', '7d'),
      'JWT_REFRESH_EXPIRY',
    );
  }

  /**
   * Registers a new user with optional Government ID verification.
   * Enforces Anti-Account Reset policy: rejects registration if the Government ID is already bound.
   */
  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    if (!dto.phone && !dto.email) {
      throw new ConflictException('Either phone number or email address is required.');
    }

    const publicRoles: readonly UserRole[] = [UserRole.ATHLETE, UserRole.ORGANIZER, UserRole.SCOUT];
    const role = dto.role ?? UserRole.ATHLETE;
    const pendingStaff = role === UserRole.ORGANIZER || role === UserRole.SCOUT;
    if (pendingStaff && !dto.governmentId)
      throw new BadRequestException(
        'Organizer and scout signup requires an identity for administrator review',
      );
    if (!publicRoles.includes(role)) {
      const invite = this.configService.get<string>('auth.adminInviteCode');
      const supplied = dto.adminInviteCode;
      const validInvite =
        invite &&
        supplied &&
        crypto.timingSafeEqual(
          crypto.createHash('sha256').update(invite).digest(),
          crypto.createHash('sha256').update(supplied).digest(),
        );
      if (role !== UserRole.SUPER_ADMIN || !validInvite) {
        throw new ForbiddenException('This role requires a valid administrator invitation.');
      }
    }

    if (
      dto.profile &&
      (!Number.isFinite(Date.parse(dto.profile.dateOfBirth)) ||
        new Date(dto.profile.dateOfBirth) > new Date())
    )
      throw new BadRequestException('dateOfBirth must be a valid past date');
    const proof = await verifyContactProof(this.configService, dto);
    const production =
      this.configService.get<string>('app.nodeEnv', 'development') === 'production';
    let precomputedIdHash: string | null = null;
    if (dto.governmentId) {
      precomputedIdHash = this.identityService.hashGovernmentId(
        dto.governmentId.idNumber,
        dto.governmentId.idType,
      );

      const existingRecord = await this.identityService.findByGovernmentId(
        dto.governmentId.idNumber,
        dto.governmentId.idType,
      );
      if (existingRecord) {
        if (
          ['REVOKED', 'FLAGGED_DUPLICATE'].includes(existingRecord.status) ||
          existingRecord.user.isRecoveryBlocked
        ) {
          await this.prisma.securityAuditLog.create({
            data: {
              userId: null,
              actorUserId: null,
              targetId: existingRecord.userId,
              category: 'GOV_ID_RESET',
              severity: 'WARNING',
              summary: 'Existing permanent identity access blocked during registration',
              action: 'GOV_ID_DUPLICATE_ATTEMPT',
              resource: 'identity_verification',
              resourceId: existingRecord.id,
              metadata: { outcome: 'BLOCKED_IDENTITY_OR_ACCOUNT_ACCESS' },
            },
          });
        }
        assertIdentityAccess(existingRecord.status);
        const existingUser = existingRecord.user;
        if (existingUser.isRecoveryBlocked)
          throw new ForbiddenException('This account requires administrator reactivation');
        const contactMatches =
          (dto.phone !== undefined && dto.phone === existingUser.phone) ||
          (dto.email !== undefined && dto.email === existingUser.email);

        if (contactMatches) {
          const restoredUser = await runSerializableTransaction(
            this.prisma,
            async (transaction) => {
              const user = await transaction.user.update({
                where: { id: existingUser.id },
                data: {
                  isActive: true,
                },
                include: { athleteProfile: { select: { id: true } } },
              });
              await transaction.identityVerification.update({
                where: { id: existingRecord.id },
                data: { reLinkedCount: { increment: 1 } },
              });
              return user;
            },
          );

          this.logger.log(
            `Permanent athlete profile ${restoredUser.id} re-attached after Government ID verification.`,
          );
          return this.generateAuthResponse(
            restoredUser.id,
            restoredUser.role,
            restoredUser.phone,
            restoredUser.email,
            existingRecord.status === VerificationStatus.VERIFIED,
            restoredUser.athleteProfile?.id ?? null,
          );
        }

        await this.prisma.securityAuditLog.create({
          data: {
            userId: null,
            actorUserId: null,
            targetId: existingRecord.userId,
            category: 'GOV_ID_RESET',
            severity: 'WARNING',
            summary: 'Duplicate government identity blocked during signup',
            action: 'GOV_ID_DUPLICATE_ATTEMPT',
            resource: 'identity_verification',
            resourceId: existingRecord.id,
            metadata: { outcome: 'BLOCKED_REGISTRATION' },
          },
        });
        this.logger.warn(
          `Anti-Reset Loophole Blocked on Registration: Gov ID hash match for existing user ${existingRecord.userId}`,
        );
        throw new ConflictException(
          `A verified Kheleo sports profile is already linked to this Government ID (Hash: ${precomputedIdHash.substring(0, 8)}...). Duplicate account creation is strictly forbidden to preserve GTI integrity. Please log in using your existing historical profile.`,
        );
      }
    }

    if (dto.phone) {
      const existingPhone = await this.prisma.user.findUnique({
        where: { phone: dto.phone },
        select: { id: true },
      });
      if (existingPhone) {
        throw new ConflictException('A user account with this phone number already exists.');
      }
    }

    if (dto.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });
      if (existingEmail) {
        throw new ConflictException('A user account with this email address already exists.');
      }
    }

    // Transactional creation of User, Profile, and IdentityVerification
    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          ...(proof ? { id: proof.subject } : {}),
          phone: dto.phone,
          email: dto.email,
          role,
          isActive: true,
        },
      });

      let profileId: string | undefined;
      if (role === UserRole.ATHLETE && dto.profile) {
        const profile = await tx.athleteProfile.create({
          data: {
            userId: newUser.id,
            dateOfBirth: new Date(dto.profile.dateOfBirth),
            gender: dto.profile.gender,
            primarySport: dto.profile.primarySport,
            secondarySports: dto.profile.secondarySports ?? [],
            district: dto.profile.district,
            state: dto.profile.state,
            tierClassification: dto.profile.tierClassification,
            heightCm: dto.profile.heightCm,
            weightKg: dto.profile.weightKg,
            dominantSide: dto.profile.dominantSide,
            currentGti: 30.0,
            wearableScore: 50.0,
            matchPerfScore: 50.0,
          },
        });
        profileId = profile.id;
      }

      if (dto.governmentId && precomputedIdHash) {
        await tx.identityVerification.create({
          data: {
            userId: newUser.id,
            idHash: precomputedIdHash,
            idType: dto.governmentId.idType,
            saltVersion: this.identityService.getConfiguredSaltVersion(),
            status:
              production || pendingStaff
                ? VerificationStatus.UNVERIFIED
                : VerificationStatus.VERIFIED,
            verifiedAt: new Date(),
          },
        });
      }

      return { ...newUser, athleteProfileId: profileId ?? null };
    });

    const isVerified = Boolean(precomputedIdHash) && !production && !pendingStaff;
    return this.generateAuthResponse(
      user.id,
      user.role,
      user.phone,
      user.email,
      isVerified,
      user.athleteProfileId,
    );
  }

  /**
   * Log into Kheleo using phone or email.
   */
  async login(dto: LoginDto): Promise<AuthResponseDto> {
    if (
      typeof dto.governmentId?.idNumber !== 'string' ||
      !dto.governmentId.idNumber.trim() ||
      !Object.values(GovIdType).includes(dto.governmentId.idType)
    ) {
      throw new BadRequestException('governmentId with idType and idNumber is required');
    }
    if (!dto.phone && !dto.email) {
      throw new UnauthorizedException('Either phone or email must be provided to log in.');
    }

    await verifyContactProof(this.configService, dto);
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(dto.phone ? [{ phone: dto.phone }] : []),
          ...(dto.email ? [{ email: dto.email }] : []),
        ],
      },
      include: {
        athleteProfile: { select: { id: true } },
        identityRecord: { select: { idHash: true, status: true } },
      },
    });

    if (!user) {
      throw new UnauthorizedException(
        'User not found. Please register to create your Kheleo passport.',
      );
    }

    assertAccountAccess(user);

    if (!user.identityRecord) {
      throw new UnauthorizedException('Government ID verification is required before login.');
    }

    const storedHash = Buffer.from(user.identityRecord.idHash, 'hex');
    const identityMatches = this.identityService
      .computeCandidateHashes(dto.governmentId.idNumber, dto.governmentId.idType)
      .map(
        (hash) =>
          storedHash.length === 32 && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), storedHash),
      )
      .some(Boolean);
    if (!identityMatches) {
      throw new UnauthorizedException('Invalid login credentials.');
    }

    const isVerified = user.identityRecord?.status === VerificationStatus.VERIFIED;
    const athleteProfileId = user.athleteProfile?.id ?? null;

    return this.generateAuthResponse(
      user.id,
      user.role,
      user.phone,
      user.email,
      isVerified,
      athleteProfileId,
    );
  }

  /**
   * Dedicated Government ID verification and anti-account reset binder.
   */
  async verifyGovernmentId(
    userId: string,
    dto: VerifyGovIdDto,
  ): Promise<GovernmentIdVerificationResponse> {
    const record = await this.identityService.verifyAndBindGovernmentId(
      userId,
      dto.idNumber,
      dto.idType,
    );

    const owner = await this.prisma.user.findUniqueOrThrow({
      where: { id: record.userId },
      include: { athleteProfile: { select: { id: true, currentGti: true } } },
    });
    return {
      message:
        record.status === VerificationStatus.VERIFIED
          ? 'Government ID verified and bound to athlete passport.'
          : 'Government ID bound; administrator verification is pending.',
      verified: record.status === VerificationStatus.VERIFIED,
      idHashPrefix: record.idHash.substring(0, 8),
      userId: owner.id,
      athleteProfileId: owner.athleteProfile?.id ?? null,
      currentGti: owner.athleteProfile ? Number(owner.athleteProfile.currentGti) : null,
      ...(owner.id !== userId
        ? {
            auth: await this.generateAuthResponse(
              owner.id,
              owner.role,
              owner.phone,
              owner.email,
              record.status === VerificationStatus.VERIFIED,
              owner.athleteProfile?.id ?? null,
            ),
          }
        : {}),
    };
  }

  /**
   * Rotates and refreshes lightweight JWT tokens.
   */
  async refreshTokens(refreshTokenStr: string): Promise<AuthResponseDto> {
    const tokenHash = crypto.createHash('sha256').update(refreshTokenStr).digest('hex');

    const result = await runSerializableTransaction(this.prisma, async (transaction) => {
      const storedToken = await transaction.refreshToken.findUnique({
        where: { tokenHash },
        include: {
          user: {
            include: {
              athleteProfile: { select: { id: true } },
              identityRecord: { select: { status: true } },
            },
          },
        },
      });

      if (!storedToken) {
        throw new UnauthorizedException('Invalid refresh token.');
      }

      assertAccountAccess(storedToken.user);

      if (storedToken.revoked || storedToken.expiresAt <= new Date()) {
        // Security measure: Revoke all tokens in family on reuse detection
        await transaction.refreshToken.updateMany({
          where: { family: storedToken.family },
          data: { revoked: true },
        });
        return { error: new UnauthorizedException('Refresh token expired or compromised.') };
      }

      const revokeResult = await transaction.refreshToken.updateMany({
        where: { id: storedToken.id, revoked: false },
        data: { revoked: true },
      });
      if (revokeResult.count !== 1) {
        await transaction.refreshToken.updateMany({
          where: { family: storedToken.family },
          data: { revoked: true },
        });
        return { error: new UnauthorizedException('Refresh token replay detected.') };
      }

      const user = storedToken.user;
      const isVerified = user.identityRecord?.status === VerificationStatus.VERIFIED;

      return {
        auth: await this.generateAuthResponse(
          user.id,
          user.role,
          user.phone,
          user.email,
          isVerified,
          user.athleteProfile?.id ?? null,
          storedToken.family,
          transaction,
        ),
      };
    });
    if ('error' in result) throw result.error;
    return result.auth;
  }

  /**
   * Revokes all active refresh tokens for the user across all sessions.
   */
  async logout(userId: string): Promise<{ success: boolean; message: string }> {
    await runSerializableTransaction(this.prisma, async (transaction) => {
      await transaction.refreshToken.updateMany({
        where: { userId },
        data: { revoked: true },
      });
    });
    this.logger.log(`All refresh tokens revoked for user ${userId}`);
    return { success: true, message: 'Logged out successfully' };
  }

  /**
   * Produces compact JWT tokens tailored for high-latency mobile networks.
   */
  private async generateAuthResponse(
    userId: string,
    role: UserRole,
    phone: string | null,
    email: string | null,
    isVerified: boolean,
    athleteProfileId: string | null,
    existingFamily?: string,
    transaction: Prisma.TransactionClient = this.prisma,
  ): Promise<AuthResponseDto> {
    // Lightweight payload
    const payload = {
      sub: userId,
      role,
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
    };

    const accessToken = jwt.sign(payload, this.privateKey, {
      algorithm: this.algorithm,
      expiresIn: this.accessExpirySeconds,
    });

    // Generate random refresh token
    const rawRefreshToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    const family = existingFamily ?? crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + this.refreshExpirySeconds * 1000);

    await transaction.refreshToken.create({
      data: {
        userId,
        tokenHash,
        family,
        expiresAt,
        revoked: false,
      },
    });

    const userSummary: AuthUserSummaryDto = {
      id: userId,
      phone,
      email,
      role,
      isVerified,
      athleteProfileId,
    };

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessExpirySeconds,
      user: userSummary,
    };
  }
}
