import 'reflect-metadata';
import { Module, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import { createAuthFixture, TEST_SECRET, TestProfile, TestUser } from './auth-passport.fixture';
import { makeTournament, TOURNAMENT_ID, BRACKET_ID } from './competition.fixture';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { RedisService } from '../../src/infrastructure/cache/redis.service';
import {
  QueueProducerService,
  GtiRecalculationPayload,
  ScoutAlertPayload,
} from '../../src/infrastructure/queues/queue-producer.service';
import {
  WsEventGateway,
  AutonomousMatchPausePayload,
} from '../../src/infrastructure/realtime/ws-event.gateway';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { WsAuthGuard } from '../../src/infrastructure/realtime/ws-auth.guard';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { HmacTamperGuard } from '../../src/common/guards/hmac-tamper.guard';
import { IdempotencyInterceptor } from '../../src/common/interceptors/idempotency.interceptor';
import { SafetyController } from '../../src/modules/safety/safety.controller';
import { SafetyService } from '../../src/modules/safety/safety.service';
import { TelemetryAuthGuard } from '../../src/modules/safety/telemetry-auth.guard';
import { DrillsController } from '../../src/modules/drills/drills.controller';
import { DrillsService } from '../../src/modules/drills/drills.service';
import { DrillSignatureGuard } from '../../src/modules/drills/guards/drill-signature.guard';
import { GtiController } from '../../src/modules/gti/gti.controller';
import { GtiService } from '../../src/modules/gti/gti.service';
import { AdminController } from '../../src/modules/admin/admin.controller';
import { AdminService } from '../../src/modules/admin/admin.service';
import { HealthService } from '../../src/modules/health/health.service';
import { LeaderboardsService } from '../../src/modules/leaderboards/leaderboards.service';
import { MatchResultsController } from '../../src/modules/tournaments/match-results.controller';
import { MatchResultsService } from '../../src/modules/tournaments/match-results.service';

type Row = { id: string } & Record<string, unknown>;
type Fields = Readonly<Record<string, unknown>>;
interface Args {
  where?: Fields;
  data?: Fields;
  create?: Fields;
  update?: Fields;
  take?: number;
  cursor?: { id: string };
  skip?: number;
  orderBy?: Fields | Fields[];
}
const fields = (value: unknown): Fields =>
  typeof value === 'object' && value !== null ? (value as Fields) : {};
const value = (item: unknown): unknown =>
  item instanceof Date ? item.getTime() : item instanceof Prisma.Decimal ? item.toNumber() : item;
function compare(a: unknown, b: unknown): number {
  const left = value(a);
  const right = value(b);
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return String(left).localeCompare(String(right), 'en', { numeric: true });
}
function matches(row: unknown, where: unknown): boolean {
  return Object.entries(fields(where)).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === 'OR')
      return Array.isArray(expected) && expected.some((branch: unknown) => matches(row, branch));
    if (key === 'AND')
      return (Array.isArray(expected) ? expected : [expected]).every((branch: unknown) =>
        matches(row, branch),
      );
    if (key.includes('_')) return matches(row, expected);
    const actual = fields(row)[key];
    if (
      expected === null ||
      typeof expected !== 'object' ||
      expected instanceof Date ||
      expected instanceof Prisma.Decimal
    )
      return compare(actual, expected) === 0;
    const condition = fields(expected);
    if ('has' in condition) return Array.isArray(actual) && actual.includes(condition.has);
    if ('some' in condition)
      return (
        Array.isArray(actual) && actual.some((entry: unknown) => matches(entry, condition.some))
      );
    if ('in' in condition)
      return (
        Array.isArray(condition.in) &&
        condition.in.some((entry: unknown) => compare(actual, entry) === 0)
      );
    if ('notIn' in condition)
      return (
        Array.isArray(condition.notIn) &&
        !condition.notIn.some((entry: unknown) => compare(actual, entry) === 0)
      );
    if ('equals' in condition)
      return condition.mode === 'insensitive'
        ? String(actual).toLowerCase() === String(condition.equals).toLowerCase()
        : compare(actual, condition.equals) === 0;
    if ('not' in condition && compare(actual, condition.not) === 0) return false;
    if ('gte' in condition && compare(actual, condition.gte) < 0) return false;
    if ('lte' in condition && compare(actual, condition.lte) > 0) return false;
    if (Object.keys(condition).some((op) => ['not', 'gte', 'lte'].includes(op))) return true;
    return matches(actual, condition);
  });
}
function clone<T>(item: T): T {
  if (item instanceof Date) return new Date(item) as T;
  if (item instanceof Prisma.Decimal) return new Prisma.Decimal(item) as T;
  if (Array.isArray(item)) return item.map((entry: unknown) => clone(entry)) as T;
  if (item && typeof item === 'object')
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]: [string, unknown]) => [key, clone(entry)]),
    ) as T;
  return item;
}
export const ATHLETE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OPPONENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ORGANIZER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const UMPIRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const SUPER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const SCOUT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const MATCH_ID = '12121212-1212-4212-8212-121212121212';
export const DRILL_SECRET = 'fixture-drill-service-secret';
export const TELEMETRY_SECRET = 'fixture-telemetry-service-secret';

export async function createSecurityFixture() {
  const auth = createAuthFixture({
    config: { 'auth.drillHmacSecret': DRILL_SECRET, 'auth.telemetryHmacSecret': TELEMETRY_SECRET },
  });
  await auth.passports.upsertPassport(auth.state.user.id, {
    primarySport: 'CRICKET',
    district: 'Pune',
    state: 'Maharashtra',
  });
  const names = [
    'user',
    'athleteProfile',
    'identityVerification',
    'drillSubmission',
    'healthAlert',
    'wearableSession',
    'scoutAlert',
    'gtiHistory',
    'sportPassportRecord',
    'tournament',
    'bracket',
    'match',
    'registration',
    'verifiedMatchResult',
    'securityAuditLog',
    'refreshToken',
  ] as const;
  type Table = (typeof names)[number];
  const tables = Object.fromEntries(names.map((name) => [name, new Map<string, Row>()])) as Record<
    Table,
    Map<string, Row>
  >;
  const state = {
    tables,
    reads: [] as Array<{ model: Table; inTransaction: boolean }>,
    writes: [] as Array<{ model: Table; data: Fields }>,
    jobs: [] as GtiRecalculationPayload[],
    scoutJobs: [] as ScoutAlertPayload[],
    pauses: [] as AutonomousMatchPausePayload[],
    scoutEvents: [] as ScoutAlertPayload[],
    depth: 0,
    attempts: 0,
    failCommit: false,
    onBegin: undefined as ((attempt: number) => void) | undefined,
  };
  const seedUser = (id: string, role: UserRole): void => {
    const user = {
      ...clone(auth.state.user),
      id,
      email: `${role}.${id}@fixture.test`,
      role,
      athleteProfile: null,
      identityRecord: null,
    };
    tables.user.set(id, user);
    tables.identityVerification.set(id, {
      ...clone(auth.state.user.identityRecord!),
      id,
      userId: id,
    });
  };
  seedUser(ATHLETE_ID, UserRole.ATHLETE);
  seedUser(OPPONENT_ID, UserRole.ATHLETE);
  seedUser(ORGANIZER_ID, UserRole.ORGANIZER);
  seedUser(UMPIRE_ID, UserRole.UMPIRE);
  seedUser(SUPER_ID, UserRole.SUPER_ADMIN);
  seedUser(SCOUT_ID, UserRole.SCOUT);
  for (const userId of [ATHLETE_ID, OPPONENT_ID]) {
    const profile = {
      ...clone(auth.state.profile!),
      id: randomUUID(),
      userId,
      user: undefined,
      sportRecords: undefined,
      gtiHistories: undefined,
      isScoutSearchable: true,
    };
    tables.athleteProfile.set(profile.id, profile);
    tables.sportPassportRecord.set(userId, {
      id: userId,
      athleteId: profile.id,
      sport: 'CRICKET',
      primaryRole: 'BATSMAN',
      totalMatches: 0,
      winCount: 0,
      winStreak: 0,
    });
    tables.registration.set(userId, {
      id: userId,
      userId,
      bracketId: BRACKET_ID,
      status: 'CONFIRMED',
      teamId: null,
    });
  }
  tables.tournament.set(TOURNAMENT_ID, {
    ...makeTournament({ organizerId: ORGANIZER_ID, status: 'IN_PROGRESS' }),
  });
  tables.bracket.set(BRACKET_ID, {
    id: BRACKET_ID,
    tournamentId: TOURNAMENT_ID,
    minGti: new Prisma.Decimal(0),
    maxGti: new Prisma.Decimal(100),
  });
  tables.match.set(MATCH_ID, {
    id: MATCH_ID,
    bracketId: BRACKET_ID,
    status: 'LIVE',
    umpireId: UMPIRE_ID,
    teamAId: randomUUID(),
    teamBId: randomUUID(),
    teamA: { members: [{ userId: ATHLETE_ID }] },
    teamB: { members: [{ userId: OPPONENT_ID }] },
  });
  const decorate = (model: Table, row: Row): Row => {
    if (model === 'user')
      return {
        ...row,
        identityRecord:
          [...tables.identityVerification.values()].find(
            (identity) => identity.userId === row.id,
          ) ?? null,
      };
    if (model === 'athleteProfile')
      return { ...row, user: decorate('user', tables.user.get(String(row.userId))!) };
    if (model === 'verifiedMatchResult')
      return { ...row, bracket: decorate('bracket', tables.bracket.get(String(row.bracketId))!) };
    if (model === 'bracket')
      return { ...row, tournament: tables.tournament.get(String(row.tournamentId)) };
    if (model === 'match')
      return { ...row, bracket: decorate('bracket', tables.bracket.get(String(row.bracketId))!) };
    if (model === 'registration')
      return { ...row, bracket: decorate('bracket', tables.bracket.get(String(row.bracketId))!) };
    if (model === 'healthAlert')
      return {
        ...row,
        tournament: tables.tournament.get(String(row.tournamentId)) ?? null,
        match: row.matchId ? decorate('match', tables.match.get(String(row.matchId))!) : null,
      };
    return row;
  };
  const repo = (model: Table) => {
    const read = (args: Args = {}): Row[] => {
      state.reads.push({ model, inTransaction: state.depth > 0 });
      let rows = [...tables[model].values()]
        .map((row) => clone(decorate(model, row)))
        .filter((row) => matches(row, args.where));
      const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy ?? {}];
      rows.sort((a, b) => {
        for (const order of orders)
          for (const [key, direction] of Object.entries(order)) {
            const result = compare(a[key], b[key]);
            if (result) return direction === 'desc' ? -result : result;
          }
        return 0;
      });
      if (args.cursor)
        rows = rows.slice(rows.findIndex((row) => row.id === args.cursor?.id) + (args.skip ?? 0));
      return args.take === undefined ? rows : rows.slice(0, args.take);
    };
    const write = (row: Row, data: Fields): Row => {
      state.writes.push({ model, data });
      for (const [key, item] of Object.entries(data))
        if (item !== undefined)
          row[key] =
            typeof item === 'object' && item !== null && 'increment' in item
              ? Number(row[key]) + Number(item.increment)
              : item;
      return clone(decorate(model, row));
    };
    const create = async (args: Args): Promise<Row> => {
      const row: Row = {
        id: randomUUID(),
        acknowledgedAt: null,
        acknowledgedById: null,
        isAcknowledged: false,
        createdAt: new Date(),
      };
      write(row, args.data ?? {});
      tables[model].set(row.id, row);
      return clone(decorate(model, row));
    };
    const update = async (args: Args): Promise<Row> => {
      const existing = read(args)[0];
      if (!existing) throw new Error(`Missing fixture ${model}`);
      return write(tables[model].get(existing.id)!, args.data ?? {});
    };
    return {
      findUnique: async (args: Args) => read(args)[0] ?? null,
      findFirst: async (args: Args) => read(args)[0] ?? null,
      findMany: async (args: Args) => read(args),
      count: async (args: Args) => read(args).length,
      create,
      update,
      updateMany: async (args: Args) => {
        const rows = read(args);
        for (const row of rows) write(tables[model].get(row.id)!, args.data ?? {});
        return { count: rows.length };
      },
      upsert: async (args: Args) =>
        read(args)[0] ? update({ ...args, data: args.update }) : create({ data: args.create }),
    };
  };
  const client = Object.assign(Object.fromEntries(names.map((name) => [name, repo(name)])), {
    $queryRaw: async (): Promise<unknown[]> => [{ ready: 1 }],
    $transaction: async (
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel },
    ): Promise<unknown> => {
      if (options.isolationLevel !== 'Serializable') throw new Error('Expected Serializable');
      state.attempts++;
      state.onBegin?.(state.attempts);
      const snapshots = names.map(
        (name) => new Map([...tables[name]].map(([key, row]) => [key, clone(row)])),
      );
      state.depth++;
      try {
        const result = await operation(client as unknown as Prisma.TransactionClient);
        if (state.failCommit) {
          state.failCommit = false;
          throw new Prisma.PrismaClientKnownRequestError('retry', {
            code: 'P2034',
            clientVersion: '6.19.3',
          });
        }
        return result;
      } catch (error: unknown) {
        names.forEach((name, index) => {
          tables[name].clear();
          for (const [key, row] of snapshots[index]!) tables[name].set(key, row);
        });
        throw error;
      } finally {
        state.depth--;
      }
    },
  });
  const prisma = client as unknown as PrismaService;
  const queue = {
    enqueueGtiRecalculation: async (payload: GtiRecalculationPayload) => {
      state.jobs.push(payload);
      return randomUUID();
    },
    enqueueScoutAlert: async (payload: ScoutAlertPayload) => {
      state.scoutJobs.push(payload);
      return randomUUID();
    },
  } as unknown as QueueProducerService;
  const ws = {
    broadcastAutonomousMatchPause: (payload: AutonomousMatchPausePayload) =>
      state.pauses.push(payload),
    broadcastGtiUpdated: () => {},
    broadcastScoutTalent: (payload: ScoutAlertPayload) => state.scoutEvents.push(payload),
  } as unknown as WsEventGateway;
  const zsets = new Map<string, Map<string, number>>();
  const memberships = new Map<string, string[]>();
  const redisClient = {
    ping: async () => 'PONG',
    eval: async (
      _script: string,
      _count: number,
      membership: string,
      userId: string,
      score: number,
      cleanupRaw: string,
      keysRaw: string,
    ) => {
      const cleanup = JSON.parse(cleanupRaw) as string[];
      const keys = JSON.parse(keysRaw) as string[];
      for (const key of [...(memberships.get(membership) ?? []), ...cleanup])
        zsets.get(key)?.delete(userId);
      for (const key of keys) {
        if (!zsets.has(key)) zsets.set(key, new Map());
        zsets.get(key)!.set(userId, score);
      }
      memberships.set(membership, keys);
      return 1;
    },
    zcard: async (key: string) => zsets.get(key)?.size ?? 0,
    zscore: async (key: string, id: string) => zsets.get(key)?.get(id)?.toString() ?? null,
    zrevrank: async (key: string, id: string) => {
      const rank = [...(zsets.get(key) ?? [])]
        .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
        .findIndex(([member]) => member === id);
      return rank < 0 ? null : rank;
    },
    zrevrange: async (key: string, start: number, end: number) =>
      [...(zsets.get(key) ?? [])]
        .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
        .slice(start, end + 1)
        .flatMap(([id, score]) => [id, String(score)]),
  };
  const redis = Object.assign(auth.redis, { client: redisClient }) as unknown as RedisService;
  const leaderboards = new LeaderboardsService(prisma, redis);
  const jwt = new JwtStrategy(auth.config, prisma);
  const sockets = new WsAuthGuard(jwt);
  const services = {
    drills: new DrillsService(prisma, queue),
    safety: new SafetyService(prisma, ws, queue),
    gti: new GtiService(prisma, leaderboards, queue, ws),
    results: new MatchResultsService(prisma, queue),
    leaderboards,
    admin: new AdminService(prisma, new HealthService(prisma, redis), leaderboards, sockets),
  };
  const profile = (userId = ATHLETE_ID): TestProfile =>
    decorate(
      'athleteProfile',
      [...tables.athleteProfile.values()].find((p) => p.userId === userId)!,
    ) as unknown as TestProfile;
  const user = (id = ATHLETE_ID): TestUser =>
    decorate('user', tables.user.get(id)!) as unknown as TestUser;
  const setProfile = (data: Fields, userId = ATHLETE_ID): void => {
    Object.assign([...tables.athleteProfile.values()].find((p) => p.userId === userId)!, data);
  };
  const token = (id = ATHLETE_ID): string =>
    sign({ sub: id, role: user(id).role }, TEST_SECRET, { expiresIn: 900, algorithm: 'HS256' });
  return {
    auth,
    state,
    prisma,
    redis,
    redisClient,
    queue,
    ws,
    jwt,
    sockets,
    services,
    profile,
    user,
    setProfile,
    token,
    zsets,
  };
}
export type SecurityFixture = Awaited<ReturnType<typeof createSecurityFixture>>;
@Module({})
class SecurityTestModule {}
export async function createSecurityApp(fixture: SecurityFixture): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: SecurityTestModule,
      controllers: [
        SafetyController,
        DrillsController,
        GtiController,
        AdminController,
        MatchResultsController,
      ],
      providers: [
        JwtAuthGuard,
        RolesGuard,
        IdempotencyInterceptor,
        DrillSignatureGuard,
        TelemetryAuthGuard,
        HmacTamperGuard,
        { provide: ConfigService, useValue: fixture.auth.config },
        { provide: PrismaService, useValue: fixture.prisma },
        { provide: RedisService, useValue: fixture.redis },
        { provide: JwtStrategy, useValue: fixture.jwt },
        { provide: SafetyService, useValue: fixture.services.safety },
        { provide: DrillsService, useValue: fixture.services.drills },
        { provide: GtiService, useValue: fixture.services.gti },
        { provide: AdminService, useValue: fixture.services.admin },
        { provide: MatchResultsService, useValue: fixture.services.results },
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
  await app.init();
  return app;
}
