import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { CreatePassportDto } from './dto/create-passport.dto';
import { UpdatePassportDto } from './dto/update-passport.dto';
import { AddSportRecordDto } from './dto/add-sport-record.dto';
import {
  AthletePassportDto,
  SportPassportRecordSummaryDto,
} from './dto/passport-response.dto';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { Prisma, SportPassportRecord, VerificationStatus } from '@prisma/client';

@Injectable()
export class PassportService {
  private readonly logger = new Logger(PassportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves the full Digital Sports Passport:
   * Cross-sport performance logs, badges, and verified physical stats.
   */
  async getPassportByUserId(userId: string): Promise<AthletePassportDto> {
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      include: {
        sportRecords: true,
        user: {
          include: {
            identityRecord: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException(
        `Digital Sports Passport for user ${userId} not found. Please create a profile first.`,
      );
    }

    return this.mapToAthletePassportDto(profile);
  }

  /**
   * Creates a new AthleteProfile (Digital Sports Passport).
   */
  async createPassport(
    userId: string,
    dto: CreatePassportDto,
  ): Promise<AthletePassportDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} does not exist.`);
    }

    const existingProfile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
    });
    if (existingProfile) {
      throw new ConflictException(
        'A Digital Sports Passport already exists for this user.',
      );
    }

    const profile = await this.prisma.$transaction(async (tx) => {
      const created = await tx.athleteProfile.create({
        data: {
          userId,
          dateOfBirth: new Date(dto.dateOfBirth),
          gender: dto.gender,
          primarySport: dto.primarySport,
          secondarySports: dto.secondarySports ?? [],
          district: dto.district,
          state: dto.state,
          tierClassification: dto.tierClassification,
          heightCm: dto.heightCm,
          weightKg: dto.weightKg,
          dominantSide: dto.dominantSide,
          locationLat: dto.locationLat,
          locationLng: dto.locationLng,
          isScoutSearchable: dto.isScoutSearchable ?? true,
          currentGti: 30.0,
          wearableScore: 50.0,
          matchPerfScore: 50.0,
        },
      });

      // Initialize default primary sport record
      await tx.sportPassportRecord.create({
        data: {
          athleteId: created.id,
          sport: dto.primarySport,
          primaryRole: 'GENERAL_ATHLETE',
          secondaryRoles: [],
          totalMatches: 0,
          winCount: 0,
          winStreak: 0,
          verifiedMetrics: {},
          earnedBadges: [],
        },
      });

      return tx.athleteProfile.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          sportRecords: true,
          user: { include: { identityRecord: true } },
        },
      });
    });

    return this.mapToAthletePassportDto(profile);
  }

  /**
   * Updates basic profile metadata and physical stats.
   */
  async updatePassport(
    userId: string,
    dto: UpdatePassportDto,
  ): Promise<AthletePassportDto> {
    const existing = await this.prisma.athleteProfile.findUnique({
      where: { userId },
    });

    if (!existing) {
      throw new NotFoundException(
        `Digital Sports Passport for user ${userId} not found.`,
      );
    }

    const updated = await this.prisma.athleteProfile.update({
      where: { userId },
      data: {
        primarySport: dto.primarySport,
        secondarySports: dto.secondarySports,
        district: dto.district,
        state: dto.state,
        tierClassification: dto.tierClassification,
        heightCm: dto.heightCm,
        weightKg: dto.weightKg,
        dominantSide: dto.dominantSide,
        locationLat: dto.locationLat,
        locationLng: dto.locationLng,
        isScoutSearchable: dto.isScoutSearchable,
      },
      include: {
        sportRecords: true,
        user: { include: { identityRecord: true } },
      },
    });

    return this.mapToAthletePassportDto(updated);
  }

  /**
   * Upserts a cross-sport performance record (roles, badges, verified Edge-AI metrics).
   */
  async addOrUpdateSportRecord(
    userId: string,
    dto: AddSportRecordDto,
  ): Promise<SportPassportRecord> {
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new NotFoundException(`Athlete profile for user ${userId} not found.`);
    }

    const verifiedMetricsJson = (dto.verifiedMetrics ?? {}) as Prisma.InputJsonValue;
    const earnedBadgesJson = (dto.earnedBadges ?? []) as Prisma.InputJsonValue;

    const record = await this.prisma.sportPassportRecord.upsert({
      where: {
        athleteId_sport: {
          athleteId: profile.id,
          sport: dto.sport,
        },
      },
      update: {
        primaryRole: dto.primaryRole,
        secondaryRoles: dto.secondaryRoles ?? [],
        ...(dto.verifiedMetrics ? { verifiedMetrics: verifiedMetricsJson } : {}),
        ...(dto.earnedBadges ? { earnedBadges: earnedBadgesJson } : {}),
      },
      create: {
        athleteId: profile.id,
        sport: dto.sport,
        primaryRole: dto.primaryRole,
        secondaryRoles: dto.secondaryRoles ?? [],
        verifiedMetrics: verifiedMetricsJson,
        earnedBadges: earnedBadgesJson,
      },
    });

    // If sport is not primary and not in secondarySports, append it
    if (
      profile.primarySport !== dto.sport &&
      !profile.secondarySports.includes(dto.sport)
    ) {
      await this.prisma.athleteProfile.update({
        where: { id: profile.id },
        data: {
          secondarySports: {
            push: dto.sport,
          },
        },
      });
    }

    return record;
  }

  /**
   * Returns sport records with cursor-based pagination.
   */
  async listSportRecords(
    userId: string,
    query: CursorPaginationQueryDto,
  ): Promise<PaginatedResponseDto<SportPassportRecord>> {
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException(`Athlete profile for user ${userId} not found.`);
    }

    const limit = query.limit ?? 20;

    const records = await this.prisma.sportPassportRecord.findMany({
      where: {
        athleteId: profile.id,
        ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}),
      },
      take: limit + 1,
      orderBy: { id: 'asc' },
    });

    return PaginatedResponseDto.create(
      records,
      limit,
      (record: SportPassportRecord) => record.id,
    );
  }

  /**
   * Helper mapper to structure the complete AthletePassportDto.
   */
  private mapToAthletePassportDto(
    profile: Prisma.AthleteProfileGetPayload<{
      include: {
        sportRecords: true;
        user: { include: { identityRecord: true } };
      };
    }>,
  ): AthletePassportDto {
    const sportRecords: SportPassportRecordSummaryDto[] = profile.sportRecords.map(
      (sr) => ({
        id: sr.id,
        sport: sr.sport,
        primaryRole: sr.primaryRole,
        secondaryRoles: sr.secondaryRoles,
        totalMatches: sr.totalMatches,
        winCount: sr.winCount,
        winStreak: sr.winStreak,
        verifiedMetrics: (sr.verifiedMetrics as Record<string, unknown>) ?? {},
        earnedBadges: (sr.earnedBadges as Array<Record<string, unknown>>) ?? [],
        updatedAt: sr.updatedAt,
      }),
    );

    // Aggregate badges across all sport records
    const allBadges: Array<Record<string, unknown>> = [];
    for (const sr of profile.sportRecords) {
      if (Array.isArray(sr.earnedBadges)) {
        allBadges.push(...(sr.earnedBadges as Array<Record<string, unknown>>));
      }
    }

    return {
      userId: profile.userId,
      athleteProfileId: profile.id,
      dateOfBirth: profile.dateOfBirth,
      gender: profile.gender,
      primarySport: profile.primarySport,
      secondarySports: profile.secondarySports,
      district: profile.district,
      state: profile.state,
      tierClassification: profile.tierClassification,
      physicalStats: {
        heightCm: profile.heightCm ? Number(profile.heightCm) : null,
        weightKg: profile.weightKg ? Number(profile.weightKg) : null,
        dominantSide: profile.dominantSide,
      },
      currentGti: Number(profile.currentGti),
      wearableScore: Number(profile.wearableScore),
      matchPerfScore: Number(profile.matchPerfScore),
      posturePoints: profile.posturePoints,
      identityStatus:
        profile.user.identityRecord?.status ?? VerificationStatus.UNVERIFIED,
      sportRecords,
      allBadges,
    };
  }
}
