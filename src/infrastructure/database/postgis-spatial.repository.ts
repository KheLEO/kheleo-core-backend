import { Injectable } from '@nestjs/common';
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
  ): Promise<readonly SpatialTournamentRow[]> {
    const radiusMeters = radiusKm * 1000;

    const sportFilter = sport ? Prisma.sql`AND sport = ${sport}::"SportType"` : Prisma.empty;
    const cursorFilter = cursorId ? Prisma.sql`AND id > ${cursorId}::uuid` : Prisma.empty;

    const results = await this.prisma.$queryRaw<SpatialTournamentRow[]>(Prisma.sql`
      SELECT
        id,
        COALESCE(NULLIF(name, ''), title, 'Tournament') AS name,
        title,
        sport,
        status,
        min_gti::float AS min_gti,
        max_gti::float AS max_gti,
        venue_name,
        venue_lat,
        venue_lng,
        prize_pool::float AS prize_pool,
        team_size,
        max_teams,
        registration_deadline,
        start_date,
        ST_Distance(
          COALESCE(venue_geom, ST_SetSRID(ST_MakePoint(venue_lng, venue_lat), 4326))::geography,
          ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography
        ) / 1000.0 AS distance_km
      FROM tournaments
      WHERE status = 'REGISTRATION_OPEN'
        AND (venue_geom IS NOT NULL OR (venue_lat IS NOT NULL AND venue_lng IS NOT NULL))
        AND ST_DWithin(
          COALESCE(venue_geom, ST_SetSRID(ST_MakePoint(venue_lng, venue_lat), 4326))::geography,
          ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography,
          ${radiusMeters}
        )
        ${sportFilter}
        ${cursorFilter}
      ORDER BY distance_km ASC
      LIMIT ${limit}
    `);

    return results;
  }
}
