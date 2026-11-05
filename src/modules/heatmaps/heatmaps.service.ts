import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface DistrictHeatmapRecord {
  readonly state: string;
  readonly district: string;
  readonly total_athletes: number;
  readonly average_gti: number;
  readonly female_participation_pct: number;
  readonly centroid: Record<string, unknown> | null;
}

export interface RegionalHeatmapResponse {
  readonly success: boolean;
  readonly count: number;
  readonly data: DistrictHeatmapRecord[];
}

@Injectable()
export class HeatmapsService {
  private readonly logger = new Logger(HeatmapsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getRegionalHeatmap(): Promise<RegionalHeatmapResponse> {
    try {
      // 1. Attempt High-Performance PostGIS Spatial Aggregation
      const rawResults = await this.prisma.$queryRaw<
        Array<{
          state: string;
          district: string;
          total_athletes: number | bigint;
          average_gti: number | string | null;
          female_participation_pct: number | string | null;
          centroid: string | null;
        }>
      >`
        SELECT 
          state, district,
          COUNT(id)::int AS total_athletes,
          ROUND(AVG(COALESCE(NULLIF(gti, 0), current_gti, 0))::numeric, 2)::float AS average_gti,
          ROUND((COUNT(CASE WHEN UPPER(gender) = 'FEMALE' THEN 1 END)::numeric / NULLIF(COUNT(id), 0)::numeric) * 100, 2)::float AS female_participation_pct,
          CASE 
            WHEN COUNT(location) > 0 THEN ST_AsGeoJSON(ST_Centroid(ST_Collect(location)))
            WHEN COUNT(location_lat) > 0 THEN ST_AsGeoJSON(ST_MakePoint(AVG(location_lng), AVG(location_lat)))
            ELSE NULL
          END AS centroid
        FROM athlete_profiles
        WHERE district IS NOT NULL AND district <> ''
        GROUP BY state, district
        ORDER BY total_athletes DESC, state, district
        LIMIT 500;
      `;

      const formatted: DistrictHeatmapRecord[] = rawResults.map((r) => {
        let parsedCentroid: Record<string, unknown> | null = null;
        if (r.centroid) {
          try {
            parsedCentroid = JSON.parse(r.centroid) as Record<string, unknown>;
          } catch {
            parsedCentroid = null;
          }
        }

        return {
          state: r.state,
          district: r.district,
          total_athletes: Number(r.total_athletes),
          average_gti: Number(r.average_gti ?? 0),
          female_participation_pct: Number(r.female_participation_pct ?? 0),
          centroid: parsedCentroid,
        };
      });

      return {
        success: true,
        count: Math.min(500, formatted.length),
        data: formatted
          .sort(
            (a, b) =>
              b.total_athletes - a.total_athletes ||
              a.state.localeCompare(b.state) ||
              a.district.localeCompare(b.district),
          )
          .slice(0, 500),
      };
    } catch (sqlError) {
      this.logger.warn(
        `PostGIS query failed or spatial columns not populated, falling back to Prisma aggregation: ${String(sqlError)}`,
      );

      const districtMap = new Map<
        string,
        {
          state: string;
          district: string;
          total: number;
          femaleCount: number;
          gtiSum: number;
          lats: number[];
          lngs: number[];
        }
      >();

      let cursorId: string | undefined;
      do {
        const profiles = await this.prisma.athleteProfile.findMany({
          where: { district: { not: '' } },
          select: {
            id: true,
            state: true,
            district: true,
            gender: true,
            gti: true,
            currentGti: true,
            locationLat: true,
            locationLng: true,
          },
          orderBy: { id: 'asc' },
          take: 500,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        for (const profile of profiles) {
          const district = profile.district || 'UNKNOWN';
          const key = JSON.stringify([profile.state, district]);
          if (!districtMap.has(key)) {
            districtMap.set(key, {
              state: profile.state,
              district,
              total: 0,
              femaleCount: 0,
              gtiSum: 0,
              lats: [],
              lngs: [],
            });
          }

          const entry = districtMap.get(key)!;
          entry.total += 1;
          if (profile.gender?.toUpperCase() === 'FEMALE') {
            entry.femaleCount += 1;
          }
          const gtiValue = profile.gti > 0 ? profile.gti : Number(profile.currentGti) || 0;
          entry.gtiSum += gtiValue;
          if (profile.locationLat != null && profile.locationLng != null) {
            entry.lats.push(profile.locationLat);
            entry.lngs.push(profile.locationLng);
          }
        }

        cursorId = profiles.at(-1)?.id;
        if (profiles.length < 500) {
          break;
        }
      } while (cursorId);

      const formatted: DistrictHeatmapRecord[] = Array.from(districtMap.entries()).map(
        ([_key, stats]) => {
          const avgGti = stats.total > 0 ? Number((stats.gtiSum / stats.total).toFixed(2)) : 0;
          const femalePct =
            stats.total > 0 ? Number(((stats.femaleCount / stats.total) * 100).toFixed(2)) : 0;

          let centroid: Record<string, unknown> | null = null;
          if (stats.lats.length > 0 && stats.lngs.length > 0) {
            const avgLat = stats.lats.reduce((a, b) => a + b, 0) / stats.lats.length;
            const avgLng = stats.lngs.reduce((a, b) => a + b, 0) / stats.lngs.length;
            centroid = {
              type: 'Point',
              coordinates: [Number(avgLng.toFixed(6)), Number(avgLat.toFixed(6))],
            };
          }

          return {
            state: stats.state,
            district: stats.district,
            total_athletes: stats.total,
            average_gti: avgGti,
            female_participation_pct: femalePct,
            centroid,
          };
        },
      );

      return {
        success: true,
        count: formatted.length,
        data: formatted,
      };
    }
  }
}
