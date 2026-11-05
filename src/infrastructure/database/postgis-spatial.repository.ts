import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Prisma, SportType } from '@prisma/client';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface SpatialTournamentRow {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly sport: string;
  readonly status: string;
  readonly min_gti: number;
  readonly max_gti: number;
  readonly venue_name: string;
  readonly venue_lat: number;
  readonly venue_lng: number;
  readonly prize_pool: number;
  readonly distance_km: number;
  readonly registration_deadline: Date;
  readonly start_date: Date;
  readonly team_size: number;
  readonly max_teams: number;
}

export interface NearbyPage<T> {
  readonly data: readonly T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

@Injectable()
export class PostgisSpatialRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Discovers tournaments within a given radius of a GPS point.
   * Uses PostGIS ST_DWithin for indexed spatial filtering.
   */
  async findTournamentsWithinRadius(
    point: GeoPoint,
    radiusKm: number,
    sport?: SportType,
    limit = 20,
    cursorId?: string,
  ): Promise<NearbyPage<SpatialTournamentRow>> {
    const radiusMeters = radiusKm * 1000;
    const sportFilter = sport ? Prisma.sql`AND t.sport = ${sport}::"SportType"` : Prisma.empty;
    const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography`;
    let cursorDistance: number | undefined;
    if (cursorId) {
      const cursor = await this.prisma.$queryRaw<
        Array<{ readonly distance_km: number }>
      >(Prisma.sql`
        SELECT ST_Distance(t.location::geography, ${origin}) / 1000.0 AS distance_km
        FROM tournaments t WHERE t.id = ${cursorId}::uuid AND t.status = 'REGISTRATION_OPEN'
          AND t.location IS NOT NULL AND ST_DWithin(t.location::geography, ${origin}, ${radiusMeters}) ${sportFilter}
      `);
      if (!cursor[0])
        throw new BadRequestException('Cursor tournament is not in the current nearby search');
      cursorDistance = cursor[0].distance_km;
    }
    const cursorFilter =
      cursorDistance !== undefined
        ? Prisma.sql`
      WHERE distance_km > ${cursorDistance}::double precision
        OR (distance_km = ${cursorDistance}::double precision AND id > ${cursorId}::uuid)
    `
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<SpatialTournamentRow[]>(Prisma.sql`
      WITH measured AS (
        SELECT t.id, COALESCE(NULLIF(t.name, ''), t.title, 'Tournament') AS name, t.title, t.sport, t.status,
          t.min_gti::float AS min_gti, t.max_gti::float AS max_gti, t.venue_name, t.venue_lat, t.venue_lng,
          t.prize_pool::float AS prize_pool, t.team_size, t.max_teams, t.registration_deadline, t.start_date,
          ST_Distance(t.location::geography, ${origin}) / 1000.0 AS distance_km
        FROM tournaments t WHERE t.status = 'REGISTRATION_OPEN' AND t.location IS NOT NULL
          AND ST_DWithin(t.location::geography, ${origin}, ${radiusMeters}) ${sportFilter}
      )
      SELECT * FROM measured ${cursorFilter} ORDER BY distance_km ASC, id ASC LIMIT ${limit + 1}
    `);
    const has_more = rows.length > limit;
    const data = has_more ? rows.slice(0, limit) : rows;
    const next_cursor = has_more && data.length > 0 ? data[data.length - 1].id : null;
    return { data, next_cursor, has_more };
  }
}
