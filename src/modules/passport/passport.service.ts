import {
  Injectable,
  Optional,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { CreatePassportDto } from './dto/create-passport.dto';
import { UpdatePassportDto } from './dto/update-passport.dto';
import { AddSportRecordDto } from './dto/add-sport-record.dto';
import { AthletePassportDto, SportPassportRecordSummaryDto } from './dto/passport-response.dto';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { Prisma, SportPassportRecord, VerificationStatus } from '@prisma/client';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { assertAccountAccess } from '../../common/auth/account-access';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';

import { LeaderboardsService } from '../leaderboards/leaderboards.service';

const athletePassportSelect = {
  id: true,
  userId: true,
  dateOfBirth: true,
  gender: true,
  primarySport: true,
  secondarySports: true,
  district: true,
  state: true,
  tierClassification: true,
  heightCm: true,
  weightKg: true,
  dominantSide: true,
  locationLat: true,
  locationLng: true,
  isScoutSearchable: true,
  currentGti: true,
  wearableScore: true,
  matchPerfScore: true,
  posturePoints: true,
  biomechanicalScore: true,
  sportRecords: {
    orderBy: { id: 'asc' as const },
    take: 20,
    select: {
      id: true,
      sport: true,
      primaryRole: true,
      secondaryRoles: true,
      totalMatches: true,
      winCount: true,
      winStreak: true,
      verifiedMetrics: true,
      earnedBadges: true,
      updatedAt: true,
    },
  },
  user: {
    select: {
      identityRecord: { select: { status: true } },
    },
  },
} satisfies Prisma.AthleteProfileSelect;

type AthletePassportRecord = Prisma.AthleteProfileGetPayload<{
  select: typeof athletePassportSelect;
}>;

@Injectable()
export class PassportService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly leaderboards?: LeaderboardsService,
  ) {}

  /**
   * Retrieves the full Digital Sports Passport:
   * Cross-sport performance logs, badges, and verified physical stats.
   */
  async getPassportByUserId(
    userId: string,
    viewer?: AuthenticatedJwtUser,
  ): Promise<AthletePassportDto> {
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      select: athletePassportSelect,
    });

    if (!profile) {
      throw new NotFoundException(
        `Digital Sports Passport for user ${userId} not found. Please create a profile first.`,
      );
    }

    if (viewer?.role === 'SCOUT' && viewer.sub !== userId && !profile.isScoutSearchable) {
      throw new ForbiddenException('Athlete profile is not opted into scout discovery');
    }
    return this.mapToAthletePassportDto(profile);
  }

  /**
   * Creates a new AthleteProfile (Digital Sports Passport).
   */
  async createPassport(userId: string, dto: CreatePassportDto): Promise<AthletePassportDto> {
    const existing = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existing)
      throw new ConflictException('A Digital Sports Passport already exists for this user.');
    return this.upsertPassport(userId, {
      ...dto,
      isScoutSearchable: dto.isScoutSearchable ?? true,
    });
  }

  async getOrCreatePassport(userId: string): Promise<AthletePassportDto> {
    return this.upsertPassport(userId, {});
  }

  async upsertPassport(userId: string, dto: UpdatePassportDto): Promise<AthletePassportDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { identityRecord: { select: { status: true } } },
    });
    if (!user) throw new NotFoundException('User does not exist.');
    assertAccountAccess(user);
    const metadata = {
      dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      gender: dto.gender,
      primarySport: dto.primarySport,
      secondarySports: dto.secondarySports ?? undefined,
      district: dto.district ?? undefined,
      state: dto.state ?? undefined,
      tierClassification: dto.tierClassification ?? undefined,
      heightCm: dto.heightCm,
      weightKg: dto.weightKg,
      dominantSide: dto.dominantSide,
      locationLat: dto.locationLat,
      locationLng: dto.locationLng,
      isScoutSearchable: dto.isScoutSearchable ?? undefined,
    };
    const result = await runSerializableTransaction(this.prisma, async (transaction) => {
      const previous = await transaction.athleteProfile.findUnique({
        where: { userId },
        select: { primarySport: true, state: true, district: true },
      });
      const saved = await transaction.athleteProfile.upsert({
        where: { userId },
        update: metadata,
        create: {
          ...metadata,
          userId,
          dateOfBirth: metadata.dateOfBirth ?? null,
          gender: metadata.gender ?? null,
          primarySport: metadata.primarySport ?? null,
          district: metadata.district ?? '',
          state: metadata.state ?? '',
          isScoutSearchable: metadata.isScoutSearchable ?? false,
        },
        select: { id: true, primarySport: true, secondarySports: true },
      });
      if (saved.primarySport) {
        await transaction.sportPassportRecord.upsert({
          where: { athleteId_sport: { athleteId: saved.id, sport: saved.primarySport } },
          create: {
            athleteId: saved.id,
            sport: saved.primarySport,
            primaryRole: 'GENERAL_ATHLETE',
          },
          update: {},
        });
      }
      for (const record of dto.sportRecords ?? []) {
        await transaction.sportPassportRecord.upsert({
          where: { athleteId_sport: { athleteId: saved.id, sport: record.sport } },
          create: {
            athleteId: saved.id,
            sport: record.sport,
            primaryRole: record.primaryRole,
            secondaryRoles: record.secondaryRoles ?? [],
          },
          update: { primaryRole: record.primaryRole, secondaryRoles: record.secondaryRoles ?? [] },
        });
      }
      if (dto.sportRecords?.length) {
        const secondarySports = [
          ...new Set([...saved.secondarySports, ...dto.sportRecords.map((record) => record.sport)]),
        ].filter((sport) => sport !== saved.primarySport);
        await transaction.athleteProfile.update({
          where: { id: saved.id },
          data: { secondarySports },
        });
      }
      const profile = await transaction.athleteProfile.findUniqueOrThrow({
        where: { userId },
        select: athletePassportSelect,
      });
      return { profile, previous };
    });
    await this.leaderboards?.syncAthlete(userId, result.previous);
    return this.mapToAthletePassportDto(result.profile);
  }

  async updatePassport(userId: string, dto: UpdatePassportDto): Promise<AthletePassportDto> {
    const existing = await this.prisma.athleteProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Digital Sports Passport not found.');
    return this.upsertPassport(userId, dto);
  }

  /**
   * Upserts a cross-sport performance record (roles, badges, verified Edge-AI metrics).
   */
  async addOrUpdateSportRecord(
    userId: string,
    dto: AddSportRecordDto,
    actor?: AuthenticatedJwtUser,
  ): Promise<SportPassportRecord> {
    const allowVerifiedFields =
      actor &&
      (actor.role !== 'ORGANIZER' || actor.identityVerified !== false) &&
      ['ORGANIZER', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(actor.role);
    if (actor && actor.sub !== userId && !allowVerifiedFields)
      throw new ForbiddenException('You can only update your own passport');
    if (
      !allowVerifiedFields &&
      (dto.verifiedMetrics !== undefined || dto.earnedBadges !== undefined)
    ) {
      throw new ForbiddenException('Only authorized staff can write verified metrics or badges');
    }
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new NotFoundException(`Athlete profile for user ${userId} not found.`);
    }

    const verifiedMetricsJson = (dto.verifiedMetrics ?? {}) as Prisma.InputJsonValue;
    const earnedBadgesJson = (dto.earnedBadges ?? []) as Prisma.InputJsonValue;

    return runSerializableTransaction(this.prisma, async (transaction) => {
      const record = await transaction.sportPassportRecord.upsert({
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

      if (profile.primarySport !== dto.sport && !profile.secondarySports.includes(dto.sport)) {
        await transaction.athleteProfile.update({
          where: { id: profile.id },
          data: {
            secondarySports: {
              push: dto.sport,
            },
          },
        });
      }

      return record;
    });
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

    return PaginatedResponseDto.create(records, limit, (record: SportPassportRecord) => record.id);
  }

  /**
   * Helper mapper to structure the complete AthletePassportDto.
   */
  private mapToAthletePassportDto(profile: AthletePassportRecord): AthletePassportDto {
    const sportRecords: SportPassportRecordSummaryDto[] = profile.sportRecords.map((sr) => ({
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
    }));

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
      locationLat: profile.locationLat,
      locationLng: profile.locationLng,
      isScoutSearchable: profile.isScoutSearchable,
      isProfileComplete: Boolean(
        profile.dateOfBirth &&
        profile.gender &&
        profile.primarySport &&
        profile.district &&
        profile.state,
      ),
      physicalStats: {
        heightCm: profile.heightCm ? Number(profile.heightCm) : null,
        weightKg: profile.weightKg ? Number(profile.weightKg) : null,
        dominantSide: profile.dominantSide,
      },
      currentGti: Number(profile.currentGti),
      wearableScore: Number(profile.wearableScore),
      matchPerfScore: Number(profile.matchPerfScore),
      posturePoints: profile.posturePoints,
      biomechanicalScore: Number(profile.biomechanicalScore ?? 0),
      identityStatus: profile.user.identityRecord?.status ?? VerificationStatus.UNVERIFIED,
      sportRecords,
      allBadges,
    };
  }
}
