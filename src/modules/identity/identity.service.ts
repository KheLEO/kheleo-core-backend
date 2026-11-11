import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { GovIdType, IdentityVerification, Prisma, VerificationStatus } from '@prisma/client';
import * as crypto from 'node:crypto';
import { assertAccountAccess, assertIdentityAccess } from '../../common/auth/account-access';

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private readonly pepper: string;
  private readonly defaultSaltVersion: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const configuredPepper =
      this.configService.get<string>('auth.identityPepper') || process.env.IDENTITY_PEPPER;
    const isProduction =
      this.configService.get<string>('app.nodeEnv', 'development') === 'production';
    if (!configuredPepper && isProduction) {
      throw new Error('IDENTITY_PEPPER must be configured in production.');
    }
    this.pepper = configuredPepper ?? 'local-development-identity-pepper';
    this.defaultSaltVersion = this.configService.get<number>('auth.identitySaltVersion') ?? 1;
    if (!Number.isSafeInteger(this.defaultSaltVersion) || this.defaultSaltVersion < 1) {
      throw new Error('IDENTITY_SALT_VERSION must be a positive integer.');
    }
  }

  getConfiguredSaltVersion(): number {
    return this.defaultSaltVersion;
  }

  normalizeId(rawId: string): string {
    return rawId.trim().replace(/[\s-]+/g, '').toUpperCase();
  }

  validateId(rawId: string, idType: GovIdType = GovIdType.AADHAAR): string {
    const normalized = this.normalizeId(rawId);
    const nodeEnv = this.configService.get<string>('app.nodeEnv') ?? process.env.NODE_ENV;
    const appEnv = this.configService.get<string>('app.appEnv') ?? process.env.APP_ENV;
    const isProduction = nodeEnv === 'production';
    const isTest = appEnv === 'test' || nodeEnv === 'test';

    if (idType === GovIdType.AADHAAR) {
      if (isProduction && !isTest) {
        if (!/^\d{12}$/.test(normalized)) {
          throw new BadRequestException('Aadhaar must be a 12-digit numeric string in production.');
        }
      } else {
        if (normalized.length < 4 || normalized.length > 12) {
          throw new BadRequestException('Aadhaar ID must be between 4 and 12 characters.');
        }
      }
    } else {
      if (normalized.length < 4) {
        throw new BadRequestException('Government ID must be at least 4 characters.');
      }
    }

    return normalized;
  }

  computeCandidateHashes(
    idNumber: string,
    idType: GovIdType = GovIdType.AADHAAR,
  ): readonly string[] {
    return [...new Set([this.defaultSaltVersion, 1])].map((version) =>
      this.hashGovernmentId(idNumber, idType, version),
    );
  }

  async findByGovernmentId(
    idNumber: string,
    idType: GovIdType = GovIdType.AADHAAR,
  ): Promise<IdentityRecordWithUser | null> {
    for (const hash of this.computeCandidateHashes(idNumber, idType)) {
      const record = await this.findByIdHash(hash);
      if (record) return record;
    }
    return null;
  }

  /**
   * One-way irreversible cryptographic hashing function.
   * SHA-256(normalizedId + Salt + Pepper) -> 64 hex characters.
   */
  hashGovernmentId(
    idNumber: string,
    idType: GovIdType = GovIdType.AADHAAR,
    saltVersion = this.defaultSaltVersion,
  ): string {
    const normalizedId = this.normalizeId(idNumber);
    const domainSalt = `kheleo_anti_reset_v${saltVersion}_${idType}`;
    const payload = `${normalizedId}:${domainSalt}:${this.pepper}`;

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Checks whether a Government ID hash already exists in the identity ledger.
   */
  async findByIdHash(idHash: string): Promise<IdentityRecordWithUser | null> {
    return this.prisma.identityVerification.findUnique({
      where: { idHash },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            passwordHash: true,
            phone: true,
            email: true,
            role: true,
            isActive: true,
            isRecoveryBlocked: true,
            athleteProfile: { select: { id: true } },
          },
        },
      },
    });
  }

  /**
   * Looks up identity record by user ID.
   */
  async findByUserId(userId: string): Promise<IdentityVerification | null> {
    return this.prisma.identityVerification.findUnique({
      where: { userId },
    });
  }

  /**
   * Enforces Anti-Account Reset policy:
   * Rejects linking if this government ID is already bound to any existing profile.
   */
  async verifyAndBindGovernmentId(
    userId: string,
    idNumber: string,
    idType: GovIdType = GovIdType.AADHAAR,
  ): Promise<IdentityVerification> {
    this.validateId(idNumber, idType);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} does not exist.`);
    }
    assertAccountAccess(user);

    const idHash = this.hashGovernmentId(idNumber, idType, this.defaultSaltVersion);

    // Check if ID hash already exists in database
    const existing = await this.findByGovernmentId(idNumber, idType);
    if (existing) {
      if (['REVOKED', 'FLAGGED_DUPLICATE'].includes(existing.status)) {
        await this.prisma.securityAuditLog.create({
          data: {
            userId,
            actorUserId: userId,
            targetId: existing.userId,
            category: 'GOV_ID_RESET',
            severity: 'WARNING',
            summary: 'Existing permanent identity is revoked or flagged',
            action: 'GOV_ID_DUPLICATE_ATTEMPT',
            resource: 'identity_verification',
            resourceId: existing.id,
            metadata: { outcome: 'BLOCKED_IDENTITY_ACCESS' },
          },
        });
      }
      assertIdentityAccess(existing.status);
      if (existing.userId === userId) {
        // Already bound to this exact user
        return existing;
      }
      const contactMatches =
        existing.user &&
        ((user.phone !== null && user.phone === existing.user.phone) ||
          (user.email !== null && user.email === existing.user.email));
      if (contactMatches) {
        assertAccountAccess(existing.user);
        await this.prisma.identityVerification.update({
          where: { id: existing.id },
          data: { reLinkedCount: { increment: 1 }, historicalUserIds: { push: userId } },
        });
        return existing;
      }

      this.logger.warn(
        `Anti-Reset Loophole Triggered: User ${userId} attempted to bind Gov ID already owned by User ${existing.userId}`,
      );

      await this.prisma.securityAuditLog.create({
        data: {
          userId,
          actorUserId: userId,
          targetId: existing.userId,
          category: 'GOV_ID_RESET',
          severity: 'WARNING',
          summary: 'Duplicate government identity binding blocked',
          action: 'GOV_ID_DUPLICATE_ATTEMPT',
          resource: 'identity_verification',
          resourceId: existing.id,
          metadata: { outcome: 'BLOCKED_BINDING' },
        },
      });

      // Record attempted duplicate link in metadata
      await this.prisma.identityVerification.update({
        where: { id: existing.id },
        data: {
          reLinkedCount: { increment: 1 },
          historicalUserIds: {
            push: userId,
          },
        },
      });

      throw new ConflictException(
        `A verified Kheleo sports profile is already linked to this Government ID (Hash: ${idHash.substring(0, 8)}...). Duplicate account creation is strictly forbidden to preserve GTI integrity. Please log in using your existing historical profile.`,
      );
    }

    // Check if user already has an identity verification attached
    const existingUserVerification = await this.findByUserId(userId);
    if (existingUserVerification) {
      throw new ConflictException(
        'This user account already has a verified Government ID attached.',
      );
    }

    // Persist new unique identity verification
    return this.prisma.identityVerification.create({
      data: {
        userId,
        idHash,
        idType,
        saltVersion: this.defaultSaltVersion,
        status:
          this.configService.get<string>('app.nodeEnv', 'development') === 'production' ||
          ['ORGANIZER', 'SCOUT'].includes(user.role)
            ? VerificationStatus.UNVERIFIED
            : VerificationStatus.VERIFIED,
        verifiedAt: new Date(),
        metadata: {
          hashAlgorithm: 'SHA-256',
          saltVersion: this.defaultSaltVersion,
          verifiedTimestamp: new Date().toISOString(),
        },
      },
    });
  }
}

export type IdentityRecordWithUser = Prisma.IdentityVerificationGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        name: true;
        passwordHash: true;
        phone: true;
        email: true;
        role: true;
        isActive: true;
        isRecoveryBlocked: true;
        athleteProfile: { select: { id: true } };
      };
    };
  };
}>;
