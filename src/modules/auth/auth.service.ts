import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { IdentityService } from '../identity/identity.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyGovIdDto } from './dto/verify-gov-id.dto';
import { AuthResponseDto, AuthUserSummaryDto } from './dto/auth-response.dto';
import { UserRole, VerificationStatus } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly privateKey: string;
  private readonly algorithm: jwt.Algorithm;
  private readonly accessExpirySeconds = 900; // 15 mins
  private readonly refreshExpiryDays = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly identityService: IdentityService,
    private readonly configService: ConfigService,
  ) {
    const privateKeyPath = this.configService.get<string>(
      'auth.jwtPrivateKeyPath',
      './keys/private.pem',
    );
    const publicKeyPath = this.configService.get<string>(
      'auth.jwtPublicKeyPath',
      './keys/public.pem',
    );

    let key = '';
    const privateKeyExists = fs.existsSync(privateKeyPath);
    const publicKeyExists = fs.existsSync(publicKeyPath);
    if (privateKeyExists !== publicKeyExists) {
      throw new Error('Both JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must exist.');
    }
    try {
      if (privateKeyExists) {
        key = fs.readFileSync(privateKeyPath, 'utf-8');
      }
    } catch {
      key = '';
    }

    if (key.includes('BEGIN PRIVATE KEY') || key.includes('BEGIN RSA PRIVATE KEY')) {
      this.privateKey = key;
      this.algorithm = 'RS256';
    } else {
      const symmetricSecret = this.configService.get<string>('auth.identityPepper');
      const isProduction =
        this.configService.get<string>('app.nodeEnv', 'development') === 'production';
      if (!symmetricSecret && isProduction) {
        throw new Error('JWT key pair or IDENTITY_PEPPER must be configured in production.');
      }
      this.privateKey = symmetricSecret ?? 'local-development-jwt-secret';
      this.algorithm = 'HS256';
    }
  }

  /**
   * Registers a new user with optional Government ID verification.
   * Enforces Anti-Account Reset policy: rejects registration if the Government ID is already bound.
   */
  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    if (!dto.phone && !dto.email) {
      throw new ConflictException('Either phone number or email address is required.');
    }

    if (dto.role && dto.role !== UserRole.ATHLETE) {
      throw new ForbiddenException('Public registration can only create ATHLETE accounts.');
    }

    let precomputedIdHash: string | null = null;
    if (dto.governmentId) {
      precomputedIdHash = this.identityService.hashGovernmentId(
        dto.governmentId.idNumber,
        dto.governmentId.idType,
      );

      const existingRecord = await this.identityService.findByIdHash(precomputedIdHash);
      if (existingRecord) {
        const existingUser = existingRecord.user;
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
                  phone: dto.phone ?? existingUser.phone,
                  email: dto.email ?? existingUser.email,
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

    const role = dto.role ?? UserRole.ATHLETE;

    // Transactional creation of User, Profile, and IdentityVerification
    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
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
            saltVersion: 1,
            status: VerificationStatus.VERIFIED,
            verifiedAt: new Date(),
          },
        });
      }

      return { ...newUser, athleteProfileId: profileId ?? null };
    });

    const isVerified = Boolean(precomputedIdHash);
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
    if (!dto.phone && !dto.email) {
      throw new UnauthorizedException('Either phone or email must be provided to log in.');
    }

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

    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated.');
    }

    if (!user.identityRecord) {
      throw new UnauthorizedException('Government ID verification is required before login.');
    }

    const suppliedIdHash = this.identityService.hashGovernmentId(
      dto.governmentId.idNumber,
      dto.governmentId.idType,
    );
    const identityMatches = crypto.timingSafeEqual(
      Buffer.from(suppliedIdHash, 'hex'),
      Buffer.from(user.identityRecord.idHash, 'hex'),
    );
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
  ): Promise<{ message: string; verified: boolean; idHashPrefix: string }> {
    const record = await this.identityService.verifyAndBindGovernmentId(
      userId,
      dto.idNumber,
      dto.idType,
    );

    return {
      message: 'Government ID verified and bound to athlete passport.',
      verified: record.status === VerificationStatus.VERIFIED,
      idHashPrefix: record.idHash.substring(0, 8),
    };
  }

  /**
   * Rotates and refreshes lightweight JWT tokens.
   */
  async refreshTokens(refreshTokenStr: string): Promise<AuthResponseDto> {
    const tokenHash = crypto.createHash('sha256').update(refreshTokenStr).digest('hex');

    const storedToken = await this.prisma.refreshToken.findUnique({
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

    if (storedToken.revoked || storedToken.expiresAt < new Date()) {
      // Security measure: Revoke all tokens in family on reuse detection
      await this.prisma.refreshToken.updateMany({
        where: { family: storedToken.family },
        data: { revoked: true },
      });
      throw new UnauthorizedException('Refresh token expired or compromised.');
    }

    const revokeResult = await this.prisma.refreshToken.updateMany({
      where: { id: storedToken.id, revoked: false },
      data: { revoked: true },
    });
    if (revokeResult.count !== 1) {
      await this.prisma.refreshToken.updateMany({
        where: { family: storedToken.family },
        data: { revoked: true },
      });
      throw new UnauthorizedException('Refresh token replay detected.');
    }

    const user = storedToken.user;
    const isVerified = user.identityRecord?.status === VerificationStatus.VERIFIED;

    return this.generateAuthResponse(
      user.id,
      user.role,
      user.phone,
      user.email,
      isVerified,
      user.athleteProfile?.id ?? null,
      storedToken.family,
    );
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
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.refreshExpiryDays);

    await this.prisma.refreshToken.create({
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
