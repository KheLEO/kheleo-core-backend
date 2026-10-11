import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  PostgisSpatialRepository,
  SpatialTournamentRow,
} from '../../infrastructure/database/postgis-spatial.repository';
import { NearbyTournamentsQueryDto } from './dto/nearby-tournaments-query.dto';
import { TournamentLocationDto } from './dto/tournament-location.dto';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { Tournament, TournamentStatus } from '@prisma/client';

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatialRepo: PostgisSpatialRepository,
  ) {}

  /**
   * Discovers tournaments within requested radius utilizing PostgreSQL PostGIS ST_DWithin and ST_MakePoint.
   * Strips all relational joins and returns a flat array of TournamentLocationDto to minimize Android memory overhead.
   */
  async findNearby(
    query: NearbyTournamentsQueryDto,
  ): Promise<readonly TournamentLocationDto[]> {
    const point = { lat: query.lat, lng: query.lng };
    const radiusKm = query.radius_km ?? 50;
    const limit = query.limit ?? 20;

    let rows: readonly SpatialTournamentRow[] = [];

    try {
      rows = await this.spatialRepo.findTournamentsWithinRadius(
        point,
        radiusKm,
        query.sport,
        limit,
        query.cursor,
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `PostGIS query failed or PostGIS extension unavailable: ${errorMsg}. Falling back to Haversine calculation.`,
      );

      // Fallback Haversine query using Prisma if raw PostGIS is unmigrated in dev
      const allTournaments = await this.prisma.tournament.findMany({
        where: {
          status: TournamentStatus.REGISTRATION_OPEN,
          ...(query.sport ? { sport: query.sport } : {}),
        },
        take: limit * 2,
        orderBy: { id: 'asc' },
      });

      const withDistances = allTournaments
        .map((t) => {
          const lat1 = point.lat;
          const lon1 = point.lng;
          const lat2 = t.venueLat!;
          const lon2 = t.venueLng!;

          const p = 0.017453292519943295; // Math.PI / 180
          const c = Math.cos;
          const a =
            0.5 -
            c((lat2 - lat1) * p) / 2 +
            (c(lat1 * p) * c(lat2 * p) * (1 - c((lon2 - lon1) * p))) / 2;
          const distanceKm = 12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km

          return {
            t,
            distanceKm,
          };
        })
        .filter((item) => item.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);

      return withDistances.map(({ t, distanceKm }): TournamentLocationDto => ({
        id: t.id,
        name: t.name || t.title,
        sport: t.sport,
        status: t.status,
        minGti: Number(t.minGti),
        maxGti: Number(t.maxGti),
        venueName: t.venueName,
        venueLat: t.venueLat!,
        venueLng: t.venueLng!,
        distanceKm: Math.round(distanceKm * 10) / 10,
        startDate: t.startDate.toISOString(),
        registrationDeadline: t.registrationDeadline.toISOString(),
        prizePool: Number(t.prizePool),
        maxTeams: t.maxTeams,
        teamSize: t.teamSize,
      }));
    }

    return rows.map((r): TournamentLocationDto => ({
      id: r.id,
      name: r.name || r.title,
      sport: r.sport,
      status: r.status,
      minGti: r.min_gti,
      maxGti: r.max_gti,
      venueName: r.venue_name,
      venueLat: r.venue_lat,
      venueLng: r.venue_lng,
      distanceKm: Math.round(r.distance_km * 10) / 10,
      startDate: new Date(r.start_date).toISOString(),
      registrationDeadline: new Date(r.registration_deadline).toISOString(),
      prizePool: r.prize_pool,
      maxTeams: r.max_teams,
      teamSize: r.team_size,
    }));
  }

  /**
   * Retrieves single tournament by ID with associated brackets.
   */
  async findById(id: string): Promise<Tournament> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
      include: {
        brackets: {
          orderBy: { roundOrder: 'asc' },
        },
      },
    });

    if (!tournament) {
      throw new NotFoundException(`Tournament with ID ${id} not found.`);
    }

    return tournament;
  }

  /**
   * Creates a new tournament.
   */
  async create(organizerId: string, dto: CreateTournamentDto): Promise<Tournament> {
    return this.prisma.tournament.create({
      data: {
        organizerId,
        name: dto.name,
        title: dto.name,
        sport: dto.sport,
        status: TournamentStatus.REGISTRATION_OPEN,
        minGti: dto.minGti ?? 0,
        maxGti: dto.maxGti ?? 100,
        maxTeams: dto.maxTeams,
        teamSize: dto.teamSize,
        prizePool: dto.prizePool ?? 0,
        venueName: dto.venueName,
        venueLat: dto.venueLat,
        venueLng: dto.venueLng,
        registrationDeadline: new Date(dto.registrationDeadline),
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
      },
    });
  }
}
