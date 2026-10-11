import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface SpatialTournamentRow {
  readonly id: string;
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
    sport?: string,
    limit = 20,
    cursorId?: string,
  ): Promise<readonly SpatialTournamentRow[]> {
    const radiusMeters = radiusKm * 1000;

    const sportFilter = sport ? `AND sport = '${sport}'` : '';
    const cursorFilter = cursorId
      ? `AND id > '${cursorId}'`
      : '';

    const results = await this.prisma.$queryRawUnsafe<SpatialTournamentRow[]>(`
      SELECT
        id, title, sport, status,
        min_gti::float AS min_gti,
        max_gti::float AS max_gti,
        venue_name, venue_lat, venue_lng,
        prize_pool::float AS prize_pool,
        team_size, max_teams,
        registration_deadline, start_date,
        ST_Distance(
          venue_geom::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) / 1000.0 AS distance_km
      FROM tournaments
      WHERE status = 'REGISTRATION_OPEN'
        AND venue_geom IS NOT NULL
        AND ST_DWithin(
          venue_geom::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
        ${sportFilter}
        ${cursorFilter}
      ORDER BY distance_km ASC
      LIMIT $4
    `, point.lng, point.lat, radiusMeters, limit);

    return results;
  }

  /**
   * Aggregates athlete count and average GTI by district for heatmap rendering.
   */
  async getRegionalDensity(
    sport?: string,
    state?: string,
  ): Promise<ReadonlyArray<{
    readonly district: string;
    readonly state: string;
    readonly athlete_count: number;
    readonly avg_gti: number;
    readonly center_lat: number;
    readonly center_lng: number;
  }>> {
    const sportFilter = sport ? `AND primary_sport = '${sport}'` : '';
    const stateFilter = state ? `AND state = '${state}'` : '';

    return this.prisma.$queryRawUnsafe(`
      SELECT
        district,
        state,
        COUNT(*)::int AS athlete_count,
        AVG(current_gti)::float AS avg_gti,
        AVG(location_lat)::float AS center_lat,
        AVG(location_lng)::float AS center_lng
      FROM athlete_profiles
      WHERE location_lat IS NOT NULL
        AND location_lng IS NOT NULL
        ${sportFilter}
        ${stateFilter}
      GROUP BY district, state
      ORDER BY athlete_count DESC
    `);
  }
}
