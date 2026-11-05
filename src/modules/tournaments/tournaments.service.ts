import { competitionConfig } from './competition-config';
import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  PostgisSpatialRepository,
  SpatialTournamentRow,
  NearbyPage,
} from '../../infrastructure/database/postgis-spatial.repository';
import { NearbyTournamentsQueryDto } from './dto/nearby-tournaments-query.dto';
import { TournamentLocationDto } from './dto/tournament-location.dto';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { Prisma, Tournament, TournamentStatus } from '@prisma/client';
import { UpdateTournamentDto } from './dto/update-tournament.dto';
import { ListTournamentsQueryDto } from './dto/list-tournaments-query.dto';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { runSerializableTransaction } from '../../common/database/serializable-transaction';
import { assertTournamentInvariants, assertTournamentOwner } from './tournament-policy';
import {
  geographicBoundingBox,
  haversineDistance,
} from '../../infrastructure/database/geo-distance';

const nearbyTournamentSelect = {
  id: true,
  name: true,
  title: true,
  sport: true,
  status: true,
  minGti: true,
  maxGti: true,
  venueName: true,
  venueLat: true,
  venueLng: true,
  startDate: true,
  registrationDeadline: true,
  prizePool: true,
  maxTeams: true,
  teamSize: true,
} satisfies Prisma.TournamentSelect;
type NearbyTournamentRecord = Prisma.TournamentGetPayload<{
  select: typeof nearbyTournamentSelect;
}>;

type TournamentWriteData = Omit<
  Required<CreateTournamentDto>,
  'registrationDeadline' | 'startDate' | 'endDate' | 'rulesConfig'
> & {
  readonly rulesConfig: Prisma.InputJsonObject;
  readonly title: string;
  readonly registrationDeadline: Date;
  readonly startDate: Date;
  readonly endDate: Date;
};

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatialRepo: PostgisSpatialRepository,
  ) {}

  /**
   * Discovers tournaments within requested radius utilizing PostgreSQL PostGIS ST_DWithin and ST_MakePoint.
   * Returns distance-ordered DTOs and a keyset cursor.
   */
  async findNearby(query: NearbyTournamentsQueryDto): Promise<NearbyPage<TournamentLocationDto>> {
    const point = { lat: query.lat, lng: query.lng };
    const radiusKm = query.radius_km ?? 50;
    const limit = query.limit ?? 20;

    let page: NearbyPage<SpatialTournamentRow>;

    try {
      page = await this.spatialRepo.findTournamentsWithinRadius(
        point,
        radiusKm,
        query.sport,
        limit,
        query.cursor,
      );
    } catch (err: unknown) {
      if (err instanceof HttpException) throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `PostGIS query failed or PostGIS extension unavailable: ${errorMsg}. Falling back to Haversine calculation.`,
      );

      return this.findNearbyFallback(query);
    }

    const data = page.data.map((r): TournamentLocationDto => ({
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
    return { data, next_cursor: page.next_cursor, has_more: page.has_more };
  }

  private async findNearbyFallback(
    query: NearbyTournamentsQueryDto,
  ): Promise<NearbyPage<TournamentLocationDto>> {
    const point = { lat: query.lat, lng: query.lng };
    const radiusKm = query.radius_km ?? 50;
    const limit = query.limit ?? 20;
    const box = geographicBoundingBox(point, radiusKm);
    const where: Prisma.TournamentWhereInput = {
      status: TournamentStatus.REGISTRATION_OPEN,
      sport: query.sport,
      venueLat: { gte: box.minLat, lte: box.maxLat },
      ...(!box.allLongitudes
        ? box.crossesAntimeridian
          ? { OR: [{ venueLng: { gte: box.west } }, { venueLng: { lte: box.east } }] }
          : { venueLng: { gte: box.west, lte: box.east } }
        : {}),
    };
    let cursor: { readonly id: string; readonly distance: number } | undefined;
    if (query.cursor) {
      const row = await this.prisma.tournament.findUnique({
        where: { id: query.cursor },
        select: nearbyTournamentSelect,
      });
      const distance = row ? haversineDistance(point, row.venueLat, row.venueLng) : Infinity;
      if (
        !row ||
        row.status !== TournamentStatus.REGISTRATION_OPEN ||
        (query.sport && row.sport !== query.sport) ||
        distance > radiusKm
      ) {
        throw new BadRequestException('Cursor tournament is not in the current nearby search');
      }
      cursor = { id: row.id, distance };
    }
    const nearest: Array<{ readonly row: NearbyTournamentRecord; readonly distance: number }> = [];
    let scanId: string | undefined;
    while (true) {
      const page: NearbyTournamentRecord[] = await this.prisma.tournament.findMany({
        where: { ...where, ...(scanId ? { id: { gt: scanId } } : {}) },
        select: nearbyTournamentSelect,
        orderBy: { id: 'asc' },
        take: 200,
      });
      for (const row of page) {
        const distance = haversineDistance(point, row.venueLat, row.venueLng);
        if (
          distance <= radiusKm &&
          (!cursor ||
            distance > cursor.distance ||
            (distance === cursor.distance && row.id > cursor.id))
        )
          nearest.push({ row, distance });
      }
      nearest.sort(
        (a, b) =>
          a.distance - b.distance || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
      );
      nearest.splice(limit + 1);
      if (page.length < 200) break;
      const nextId = page.at(-1)!.id;
      if (scanId && nextId <= scanId) throw new Error('Nearby fallback pagination did not advance');
      scanId = nextId;
    }
    const data = nearest.slice(0, limit).map(({ row, distance }) => ({
      id: row.id,
      name: row.name || row.title,
      sport: row.sport,
      status: row.status,
      minGti: Number(row.minGti),
      maxGti: Number(row.maxGti),
      venueName: row.venueName,
      venueLat: row.venueLat,
      venueLng: row.venueLng,
      distanceKm: Math.round(distance * 10) / 10,
      startDate: row.startDate.toISOString(),
      registrationDeadline: row.registrationDeadline.toISOString(),
      prizePool: Number(row.prizePool),
      maxTeams: row.maxTeams,
      teamSize: row.teamSize,
    }));
    const has_more = nearest.length > limit;
    return { data, has_more, next_cursor: has_more ? data.at(-1)!.id : null };
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
          take: 100,
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
    return this.prisma.tournament.create({ data: { organizerId, ...this.tournamentData(dto) } });
  }

  async list(query: ListTournamentsQueryDto): Promise<PaginatedResponseDto<Tournament>> {
    const limit = query.limit ?? 20;
    const rows = await this.prisma.tournament.findMany({
      where: {
        sport: query.sport,
        status: query.status,
        organizerId: query.organizer_id,
        ...(query.cursor_id ? { id: { gt: query.cursor_id } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return PaginatedResponseDto.create(rows, limit, (row) => row.id);
  }

  async updateTournament(
    id: string,
    actor: AuthenticatedJwtUser,
    dto: UpdateTournamentDto,
  ): Promise<Tournament> {
    return runSerializableTransaction(this.prisma, async (transaction) => {
      const existing = await transaction.tournament.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Tournament not found');
      assertTournamentOwner(existing.organizerId, actor);
      if (existing.status === TournamentStatus.SUSPENDED && actor.role === 'ORGANIZER')
        throw new BadRequestException('Suspended tournaments require administrator moderation');
      return transaction.tournament.update({
        where: { id },
        data: this.tournamentData(dto, existing),
      });
    });
  }

  async deleteTournament(id: string, actor: AuthenticatedJwtUser): Promise<Tournament> {
    return runSerializableTransaction(this.prisma, async (transaction) => {
      const existing = await transaction.tournament.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Tournament not found');
      assertTournamentOwner(existing.organizerId, actor);
      return transaction.tournament.delete({ where: { id } });
    });
  }

  private tournamentData(dto: UpdateTournamentDto, existing?: Tournament): TournamentWriteData {
    const sport = dto.sport ?? existing?.sport;
    if (!sport) throw new BadRequestException('sport is required');
    const data: TournamentWriteData = {
      rulesConfig: competitionConfig(
        dto.rulesConfig ?? existing?.rulesConfig,
        dto.teamSize ?? existing?.teamSize ?? 0,
        dto.prizePool ?? Number(existing?.prizePool ?? 0),
      ),
      name: dto.name ?? (existing?.name || existing?.title) ?? '',
      title: dto.name ?? (existing?.name || existing?.title) ?? '',
      sport,
      status: dto.status ?? existing?.status ?? TournamentStatus.REGISTRATION_OPEN,
      minGti: dto.minGti ?? Number(existing?.minGti ?? 0),
      maxGti: dto.maxGti ?? Number(existing?.maxGti ?? 100),
      maxTeams: dto.maxTeams ?? existing?.maxTeams ?? 0,
      teamSize: dto.teamSize ?? existing?.teamSize ?? 0,
      prizePool: dto.prizePool ?? Number(existing?.prizePool ?? 0),
      venueName: dto.venueName ?? existing?.venueName ?? '',
      venueLat: dto.venueLat ?? existing?.venueLat ?? NaN,
      venueLng: dto.venueLng ?? existing?.venueLng ?? NaN,
      registrationDeadline:
        dto.registrationDeadline !== undefined
          ? new Date(dto.registrationDeadline)
          : (existing?.registrationDeadline ?? new Date(NaN)),
      startDate:
        dto.startDate !== undefined
          ? new Date(dto.startDate)
          : (existing?.startDate ?? new Date(NaN)),
      endDate:
        dto.endDate !== undefined ? new Date(dto.endDate) : (existing?.endDate ?? new Date(NaN)),
    };
    if (!data.name.trim() || !data.venueName.trim())
      throw new BadRequestException('Tournament and venue names are required');
    assertTournamentInvariants(data);
    return data;
  }
}
