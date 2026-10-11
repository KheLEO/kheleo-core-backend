import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { GovIdType, IdentityVerification, Prisma, VerificationStatus } from '@prisma/client';
import * as crypto from 'node:crypto';

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
    this.defaultSaltVersion = this.configService.get<number>('auth.identitySaltVersion') || 1;
  }

  /**
   * One-way irreversible cryptographic hashing function.
   * SHA-256(normalizedId + Salt + Pepper) -> 64 hex characters.
   */
  hashGovernmentId(
    idNumber: string,
    idType: GovIdType,
    saltVersion = this.defaultSaltVersion,
  ): string {
    const normalizedId = idNumber.trim().toUpperCase().replace(/[\s-]/g, '');
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
            phone: true,
            email: true,
            role: true,
            isActive: true,
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
    idType: GovIdType,
  ): Promise<IdentityVerification> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} does not exist.`);
    }

    const idHash = this.hashGovernmentId(idNumber, idType, this.defaultSaltVersion);

    // Check if ID hash already exists in database
    const existing = await this.findByIdHash(idHash);
    if (existing) {
      if (existing.userId === userId) {
        // Already bound to this exact user
        return existing;
      }

      this.logger.warn(
        `Anti-Reset Loophole Triggered: User ${userId} attempted to bind Gov ID already owned by User ${existing.userId}`,
      );

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
        status: VerificationStatus.VERIFIED,
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
        phone: true;
        email: true;
        role: true;
        isActive: true;
        athleteProfile: { select: { id: true } };
      };
    };
  };
}>;
