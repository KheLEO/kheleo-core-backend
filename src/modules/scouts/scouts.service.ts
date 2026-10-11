import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ScoutFeedQueryDto } from './dto/scout-feed-query.dto';
import { Prisma, SportType } from '@prisma/client';

export interface ProspectSummary {
  readonly athlete_id: string;
  readonly profile_id: string;
  readonly gti: number;
  readonly primary_sport: string;
  readonly district: string;
  readonly state: string;
  readonly tier: string;
  readonly is_rural_or_underrepresented: boolean;
  readonly biomechanical_score: number;
  readonly training_consistency_score: number;
  readonly match_performance_score: number;
  readonly posture_points: number;
  readonly alert_count: number;
}

export interface ScoutFeedResponse {
  readonly success: boolean;
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly data: ProspectSummary[];
}

@Injectable()
export class ScoutsService {
  private readonly logger = new Logger(ScoutsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getScoutFeed(query: ScoutFeedQueryDto): Promise<ScoutFeedResponse> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;
    const minGti = query.min_gti ?? 0;

    const where: Prisma.AthleteProfileWhereInput = {
      isScoutSearchable: true,
      OR: [
        { gti: { gte: minGti } },
        { currentGti: { gte: new Prisma.Decimal(minGti) } },
      ],
    };

    if (query.sport) {
      const sportUpper = query.sport.toUpperCase();
      if (Object.values(SportType).includes(sportUpper as SportType)) {
        where.primarySport = sportUpper as SportType;
      }
    }

    if (query.district) {
      where.district = { equals: query.district, mode: 'insensitive' };
    }

    const [total, profiles] = await Promise.all([
      this.prisma.athleteProfile.count({ where }),
      this.prisma.athleteProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ gti: 'desc' }, { currentGti: 'desc' }],
        include: {
          user: {
            include: {
              scoutAlerts: {
                where: { isAcknowledged: false },
              },
            },
          },
        },
      }),
    ]);

    const data: ProspectSummary[] = profiles.map((p) => {
      const gtiValue = p.gti > 0 ? p.gti : Number(p.currentGti);
      return {
        athlete_id: p.userId,
        profile_id: p.id,
        gti: gtiValue,
        primary_sport: String(p.primarySport),
        district: p.district,
        state: p.state,
        tier: String(p.tierClassification),
        is_rural_or_underrepresented:
          p.isRuralOrUnderrepresented ||
          ['RURAL', 'TIER_3', 'TIER_2'].includes(String(p.tierClassification)),
        biomechanical_score: p.biomechanicalScore,
        training_consistency_score:
          p.trainingConsistencyScore > 0
            ? p.trainingConsistencyScore
            : Number(p.wearableScore),
        match_performance_score:
          p.matchPerformanceScore > 0
            ? p.matchPerformanceScore
            : Number(p.matchPerfScore),
        posture_points: p.posturePoints,
        alert_count: p.user.scoutAlerts.length,
      };
    });

    return {
      success: true,
      total,
      page,
      limit,
      data,
    };
  }

  async getAlerts(sport?: string, district?: string) {
    const where: Prisma.ScoutAlertWhereInput = {};
    if (sport) where.sport = sport;
    if (district) where.district = district;

    return this.prisma.scoutAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        athlete: {
          select: {
            id: true,
            email: true,
            phone: true,
            athleteProfile: true,
          },
        },
      },
    });
  }

  async acknowledgeAlert(alertId: string) {
    const alert = await this.prisma.scoutAlert.findUnique({
      where: { id: alertId },
    });

    if (!alert) {
      throw new NotFoundException(`Scout alert not found with ID ${alertId}`);
    }

    return this.prisma.scoutAlert.update({
      where: { id: alertId },
      data: { isAcknowledged: true },
    });
  }
}
