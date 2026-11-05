import { BadRequestException, Module, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  Bracket,
  BracketType,
  FreeAgentRegistration,
  FreeAgentStatus,
  Prisma,
  Registration,
  RegistrationStatus,
  SportType,
  Team,
  TeamMember,
  Tournament,
  TournamentStatus,
  VerificationStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createAuthFixture, TEST_USER_ID } from './auth-passport.fixture';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { RedisService } from '../../src/infrastructure/cache/redis.service';
import { PostgisSpatialRepository } from '../../src/infrastructure/database/postgis-spatial.repository';
import { TournamentsController } from '../../src/modules/tournaments/tournaments.controller';
import { TournamentsService } from '../../src/modules/tournaments/tournaments.service';
import { BracketsController } from '../../src/modules/brackets/brackets.controller';
import { BracketsService } from '../../src/modules/brackets/brackets.service';
import { MatchmakingService } from '../../src/modules/matchmaking/matchmaking.service';
import { MatchmakingController } from '../../src/modules/matchmaking/matchmaking.controller';
import {
  MatchmakingGateway,
  RosterFormedEventData,
} from '../../src/modules/matchmaking/matchmaking.gateway';
import { QueueProducerService } from '../../src/infrastructure/queues/queue-producer.service';
import { ParticipationProfile } from '../../src/modules/tournaments/participation-policy';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { IdempotencyInterceptor } from '../../src/common/interceptors/idempotency.interceptor';
import { ResponseTransformInterceptor } from '../../src/common/interceptors/response-transform.interceptor';

export const TOURNAMENT_ID = '11111111-1111-4111-8111-111111111111';
export const BRACKET_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_OWNER_ID = '33333333-3333-4333-8333-333333333333';

type Fields = Readonly<Record<string, unknown>>;
interface RepositoryArgs {
  readonly where?: Fields;
  readonly data?: Fields;
  readonly orderBy?: unknown;
  readonly take?: number;
  readonly select?: unknown;
  readonly include?: unknown;
}
interface ReadEntry {
  readonly model: string;
  readonly args: RepositoryArgs;
  readonly inTransaction: boolean;
}

function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null ? (value as Fields) : {};
}
function comparable(value: unknown): string | number | boolean | null | undefined {
  if (value instanceof Date) return value.getTime();
  if (value instanceof Prisma.Decimal) return value.toNumber();
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  return undefined;
}
function compare(a: unknown, b: unknown): number {
  const left = comparable(a);
  const right = comparable(b);
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return left < right ? -1 : 1;
}
function matches(row: unknown, where: unknown): boolean {
  const data = fields(row);
  return Object.entries(fields(where)).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === 'OR')
      return Array.isArray(expected) && expected.some((branch: unknown) => matches(row, branch));
    if (key === 'AND')
      return (Array.isArray(expected) ? expected : [expected]).every((branch: unknown) =>
        matches(row, branch),
      );
    if (key === 'bracketId_userId') return matches(row, expected);
    const actual = data[key];
    if (
      expected === null ||
      expected instanceof Date ||
      expected instanceof Prisma.Decimal ||
      typeof expected !== 'object'
    )
      return compare(actual, expected) === 0;
    const condition = fields(expected);
    if ('in' in condition)
      return (
        Array.isArray(condition.in) &&
        condition.in.some((value: unknown) => compare(actual, value) === 0)
      );
    if ('not' in condition && compare(actual, condition.not) === 0) return false;
    if ('gt' in condition && compare(actual, condition.gt) <= 0) return false;
    if ('gte' in condition && compare(actual, condition.gte) < 0) return false;
    if ('lt' in condition && compare(actual, condition.lt) >= 0) return false;
    if ('lte' in condition && compare(actual, condition.lte) > 0) return false;
    if ('none' in condition)
      return (
        Array.isArray(actual) && !actual.some((item: unknown) => matches(item, condition.none))
      );
    if ('is' in condition) return matches(actual, condition.is);
    if (
      Object.keys(condition).some((operator) =>
        ['not', 'gt', 'gte', 'lt', 'lte'].includes(operator),
      )
    )
      return true;
    return matches(actual, condition);
  });
}
function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value) as T;
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => clone(item)) as T;
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [key, clone(item)]),
    ) as T;
  return value;
}
function assign<T extends object>(row: T, data: Fields): T {
  Object.assign(
    row,
    Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  );
  return row;
}
function sorted<T extends object>(rows: T[], orderBy: unknown): T[] {
  const ordering: unknown[] = Array.isArray(orderBy) ? orderBy : [orderBy];
  return rows.sort((a, b) => {
    for (const order of ordering)
      for (const [key, direction] of Object.entries(fields(order))) {
        const difference = compare(fields(a)[key], fields(b)[key]);
        if (difference) return direction === 'desc' ? -difference : difference;
      }
    return 0;
  });
}

export function makeTournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: TOURNAMENT_ID,
    organizerId: TEST_USER_ID,
    name: 'Campus Cup',
    title: 'Campus Cup',
    isFeatured: false,
    sport: SportType.CRICKET,
    status: TournamentStatus.REGISTRATION_OPEN,
    minGti: new Prisma.Decimal(0),
    maxGti: new Prisma.Decimal(100),
    maxTeams: 16,
    teamSize: 4,
    prizePool: new Prisma.Decimal(0),
    currency: 'INR',
    venueName: 'Campus',
    venueLat: 19,
    venueLng: 72,
    registrationDeadline: new Date('2099-01-01'),
    startDate: new Date('2099-01-02'),
    endDate: new Date('2099-01-03'),
    rulesConfig: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
export function makeProfile(userId: string, gti = 50): ParticipationProfile {
  return {
    id: randomUUID(),
    userId,
    currentGti: new Prisma.Decimal(gti),
    dateOfBirth: new Date('2000-01-01'),
    gender: 'FEMALE',
    primarySport: SportType.CRICKET,
    district: 'Pune',
    state: 'Maharashtra',
    user: { isActive: true, identityRecord: { status: VerificationStatus.VERIFIED } },
  };
}

export function createCompetitionFixture() {
  const auth = createAuthFixture();
  const state = {
    tournaments: new Map<string, Tournament>(),
    brackets: new Map<string, Bracket>(),
    profiles: new Map<string, ParticipationProfile>(),
    teams: new Map<string, Team>(),
    members: new Map<string, TeamMember>(),
    registrations: new Map<string, Registration>(),
    agents: new Map<string, FreeAgentRegistration>(),
    reads: [] as ReadEntry[],
    writes: [] as Array<{ readonly model: string; readonly args: RepositoryArgs }>,
    events: [] as RosterFormedEventData[],
    enqueued: 0,
    depth: 0,
    transactions: 0,
    failNextCommit: false,
    onBegin: undefined as ((attempt: number) => void) | undefined,
  };
  state.tournaments.set(TOURNAMENT_ID, makeTournament());
  state.brackets.set(BRACKET_ID, {
    id: BRACKET_ID,
    tournamentId: TOURNAMENT_ID,
    name: 'Open',
    tierName: 'OPEN',
    minGti: new Prisma.Decimal(40),
    maxGti: new Prisma.Decimal(65),
    entryFee: new Prisma.Decimal(0),
    maxTeams: 16,
    bracketType: BracketType.SINGLE_ELIMINATION,
    roundOrder: 1,
    config: {},
  });
  state.profiles.set(TEST_USER_ID, makeProfile(TEST_USER_ID));
  const repository = <T extends { id: string }, R extends object = T>(
    model: string,
    rows: Map<string, T>,
    factory: (data: Fields) => T,
    decorate: (row: T) => R,
  ) => {
    const find = (args: RepositoryArgs): R[] => {
      state.reads.push({ model, args, inTransaction: state.depth > 0 });
      return sorted(
        [...rows.values()]
          .map((row) => clone(decorate(row)))
          .filter((row) => matches(row, args.where)),
        args.orderBy,
      ).slice(0, args.take);
    };
    return {
      findUnique: async (args: RepositoryArgs): Promise<R | null> => find(args)[0] ?? null,
      findFirst: async (args: RepositoryArgs): Promise<R | null> => find(args)[0] ?? null,
      findMany: async (args: RepositoryArgs): Promise<R[]> => find(args),
      count: async (args: RepositoryArgs): Promise<number> => find(args).length,
      create: async (args: RepositoryArgs): Promise<T> => {
        state.writes.push({ model, args });
        const row = factory(args.data ?? {});
        rows.set(row.id, row);
        return clone(row);
      },
      update: async (args: RepositoryArgs): Promise<T> => {
        state.writes.push({ model, args });
        const row = [...rows.values()].find((entry) => matches(entry, args.where));
        if (!row) throw new BadRequestException('Fixture row not found');
        return clone(assign(row, args.data ?? {}));
      },
      updateMany: async (args: RepositoryArgs): Promise<{ readonly count: number }> => {
        state.writes.push({ model, args });
        const selected = [...rows.values()].filter((row) => matches(row, args.where));
        selected.forEach((row) => assign(row, args.data ?? {}));
        return { count: selected.length };
      },
      delete: async (args: RepositoryArgs): Promise<T> => {
        state.writes.push({ model, args });
        const row = [...rows.values()].find((entry) => matches(entry, args.where));
        if (!row) throw new BadRequestException('Fixture row not found');
        rows.delete(row.id);
        return clone(row);
      },
    };
  };
  const decorateProfile = (profile: ParticipationProfile): ParticipationProfile => profile;
  const profiles = repository(
    'profile',
    state.profiles,
    (data) => assign(makeProfile(String(data.userId)), data),
    decorateProfile,
  );
  const tournaments = repository(
    'tournament',
    state.tournaments,
    (data) => assign(makeTournament({ id: randomUUID() }), data),
    (row) => row,
  );
  const brackets = repository(
    'bracket',
    state.brackets,
    (data) => assign({ ...state.brackets.get(BRACKET_ID)!, id: randomUUID() }, data),
    (row) => ({ ...row, tournament: state.tournaments.get(row.tournamentId)! }),
  );
  const registrations = repository(
    'registration',
    state.registrations,
    (data): Registration =>
      assign(
        {
          id: randomUUID(),
          bracketId: BRACKET_ID,
          userId: null,
          teamId: null,
          status: RegistrationStatus.CONFIRMED,
          feePaid: new Prisma.Decimal(0),
          registeredAt: new Date(),
          metadata: null,
        },
        data,
      ),
    (row) => row,
  );
  const teams = repository(
    'team',
    state.teams,
    (data): Team =>
      assign(
        {
          id: randomUUID(),
          tournamentId: TOURNAMENT_ID,
          bracketId: null,
          name: 'Team',
          captainId: null,
          isFreeAgentTeam: false,
          isFreeAgentFormed: false,
          compositeGti: new Prisma.Decimal(0),
          averageGti: 0,
          registrationDate: new Date(),
          createdAt: new Date(),
        },
        data,
      ),
    (row) => ({
      ...row,
      members: [...state.members.values()]
        .filter((member) => member.teamId === row.id)
        .map((member) => ({
          ...member,
          user: member.userId
            ? { athleteProfile: state.profiles.get(member.userId) ?? null }
            : null,
          athlete:
            [...state.profiles.values()].find((profile) => profile.id === member.athleteId) ?? null,
        })),
    }),
  );
  const members = repository(
    'member',
    state.members,
    (data): TeamMember =>
      assign(
        {
          id: randomUUID(),
          teamId: '',
          userId: null,
          athleteId: null,
          role: null,
          assignedRole: 'MEMBER',
          isCaptain: false,
          joinedAt: new Date(),
        },
        data,
      ),
    (row) => ({ ...row, team: state.teams.get(row.teamId) }),
  );
  const agents = repository(
    'agent',
    state.agents,
    (data): FreeAgentRegistration =>
      assign(
        {
          id: randomUUID(),
          userId: TEST_USER_ID,
          tournamentId: TOURNAMENT_ID,
          bracketId: BRACKET_ID,
          sport: 'CRICKET',
          primaryRole: 'BATSMAN',
          secondaryRole: null,
          status: FreeAgentStatus.QUEUED,
          matchedTeamId: null,
          joinedAt: new Date(),
        },
        data,
      ),
    (row) => {
      const profile = state.profiles.get(row.userId);
      return {
        ...row,
        user: {
          email: `${row.userId}@fixture.test`,
          phone: null,
          isActive: profile?.user.isActive ?? false,
          identityRecord: profile?.user.identityRecord ?? null,
          athleteProfile: profile ?? null,
          teamMembers: [...state.members.values()]
            .filter((member) => member.userId === row.userId)
            .map((member) => ({ ...member, team: state.teams.get(member.teamId) })),
        },
      };
    },
  );
  const prisma = Object.assign(auth.database, {
    athleteProfile: profiles,
    tournament: tournaments,
    bracket: brackets,
    registration: registrations,
    team: teams,
    teamMember: members,
    freeAgentRegistration: agents,
    $transaction: async (
      operation: (transaction: Prisma.TransactionClient) => Promise<unknown>,
      options?: { readonly isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<unknown> => {
      if (options?.isolationLevel !== Prisma.TransactionIsolationLevel.Serializable)
        throw new Error('Expected Serializable isolation');
      state.transactions += 1;
      state.onBegin?.(state.transactions);
      const tables = [
        state.tournaments,
        state.brackets,
        state.teams,
        state.members,
        state.registrations,
        state.agents,
      ];
      const snapshots = tables.map((table) =>
        [...table.entries()].map(([id, row]) => [id, clone(row)] as const),
      );
      state.depth += 1;
      try {
        const result = await operation(prisma);
        if (state.failNextCommit) {
          state.failNextCommit = false;
          throw new Prisma.PrismaClientKnownRequestError('Serialization conflict', {
            code: 'P2034',
            clientVersion: '6.19.3',
          });
        }
        return result;
      } catch (error: unknown) {
        tables.forEach((table, index) => {
          table.clear();
          const restore = table as Map<
            string,
            Tournament | Bracket | Team | TeamMember | Registration | FreeAgentRegistration
          >;
          for (const [id, row] of snapshots[index] ?? []) restore.set(id, row);
        });
        throw error;
      } finally {
        state.depth -= 1;
      }
    },
  });
  const queue = {
    enqueueBracketMatchmaking: async (): Promise<string> => {
      state.enqueued += 1;
      return randomUUID();
    },
  } as unknown as QueueProducerService;
  const gateway = {
    emitRosterFormed: (event: RosterFormedEventData): void => {
      state.events.push(event);
    },
  } as unknown as MatchmakingGateway;
  const spatial = {
    findTournamentsWithinRadius: async (): Promise<never> => {
      throw new Error('Use fallback in fixture');
    },
  } as unknown as PostgisSpatialRepository;
  const services = {
    tournaments: new TournamentsService(prisma, spatial),
    brackets: new BracketsService(prisma),
    matchmaking: new MatchmakingService(prisma, queue, gateway),
  };
  const addCandidate = (
    primaryRole: string,
    secondaryRole: string | null = null,
    gti = 50,
  ): FreeAgentRegistration => {
    const userId = randomUUID();
    state.profiles.set(userId, makeProfile(userId, gti));
    const row: FreeAgentRegistration = {
      id: randomUUID(),
      userId,
      tournamentId: TOURNAMENT_ID,
      bracketId: BRACKET_ID,
      sport: 'CRICKET',
      primaryRole,
      secondaryRole,
      status: FreeAgentStatus.QUEUED,
      matchedTeamId: null,
      joinedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, state.agents.size)),
    };
    state.agents.set(row.id, row);
    return row;
  };
  return { auth, state, prisma, queue, gateway, spatial, services, addCandidate };
}

@Module({})
class CompetitionTestModule {}

export async function createCompetitionApp(
  fixture: ReturnType<typeof createCompetitionFixture>,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: CompetitionTestModule,
      controllers: [TournamentsController, BracketsController, MatchmakingController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        IdempotencyInterceptor,
        { provide: ConfigService, useValue: fixture.auth.config },
        { provide: PrismaService, useValue: fixture.prisma },
        { provide: RedisService, useValue: fixture.auth.redis },
        { provide: TournamentsService, useValue: fixture.services.tournaments },
        { provide: BracketsService, useValue: fixture.services.brackets },
        { provide: MatchmakingService, useValue: fixture.services.matchmaking },
      ],
    },
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  await app.init();
  return app;
}
