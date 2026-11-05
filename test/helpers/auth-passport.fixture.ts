import 'reflect-metadata';
import { Module, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AthleteProfile,
  DrillSubmission,
  GovIdType,
  GtiHistory,
  HealthAlert,
  IdentityVerification,
  Prisma,
  RefreshToken,
  ScoutDossier,
  SportPassportRecord,
  SportType,
  TierClassification,
  User,
  UserRole,
  VerificationStatus,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { RedisService } from '../../src/infrastructure/cache/redis.service';
import { IdentityService } from '../../src/modules/identity/identity.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { IdempotencyInterceptor } from '../../src/common/interceptors/idempotency.interceptor';
import { UsersService } from '../../src/modules/users/users.service';
import { UsersController } from '../../src/modules/users/users.controller';
import { PassportService } from '../../src/modules/passport/passport.service';
import { PassportController } from '../../src/modules/passport/passport.controller';
import { ScoutsDossiersService } from '../../src/modules/scouts/dossiers.service';
import { ScoutsService } from '../../src/modules/scouts/scouts.service';
import { ScoutsController } from '../../src/modules/scouts/scouts.controller';
import { ScoutOutreachGuard } from '../../src/modules/scouts/scout-outreach.guard';
import { ResponseTransformInterceptor } from '../../src/common/interceptors/response-transform.interceptor';

export const TEST_DOCUMENT = '542189012345';
export const TEST_SECRET = 'fixture-identity-pepper-for-local-jwt';
export const SUPABASE_TEST_SECRET = 'fixture-supabase-shared-jwt-secret';
export const TEST_USER_ID = 'ccf7fc2d-5984-4356-8bfe-84666b410f66';
export const TEST_OTHER_ID = 'cdba88df-a7bf-47e8-91b8-d2b6eb6c9987';

export interface TestUser extends User {
  identityRecord: IdentityVerification | null;
  athleteProfile: { id: string; currentGti: Prisma.Decimal } | null;
  drillSubmissions: DrillSubmission[];
  healthAlerts: HealthAlert[];
}

export interface TestProfile extends AthleteProfile {
  user: TestUser;
  sportRecords: SportPassportRecord[];
  gtiHistories: GtiHistory[];
}

interface FixtureOptions {
  readonly saltVersion?: number;
  readonly storedSaltVersion?: number;
  readonly config?: Readonly<Record<string, string | number>>;
}

export interface ProfileWrite {
  readonly where: { readonly userId?: string; readonly id?: string };
  readonly data?: Readonly<Record<string, unknown>>;
  readonly create?: Readonly<Record<string, unknown>>;
  readonly update?: Readonly<Record<string, unknown>>;
  readonly select?: unknown;
}

interface SportWrite {
  readonly where: {
    readonly athleteId_sport: { readonly athleteId: string; readonly sport: SportType };
  };
  readonly create: Readonly<Record<string, unknown>>;
  readonly update: Readonly<Record<string, unknown>>;
}

function assignDefined(target: object, data: Readonly<Record<string, unknown>>): void {
  Object.assign(
    target,
    Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  );
}

class FixtureRedis {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
  async setnx(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
  async deleteIfValueMatches(key: string, value: string): Promise<boolean> {
    return this.values.get(key) === value && this.values.delete(key);
  }
}

export function createAuthFixture(options: FixtureOptions = {}) {
  const settings: Readonly<Record<string, string | number>> = {
    'auth.identityPepper': TEST_SECRET,
    'auth.identitySaltVersion': options.saltVersion ?? 1,
    'auth.supabaseJwtSecret': SUPABASE_TEST_SECRET,
    'auth.jwtPrivateKeyPath': '/nonexistent/kheleo-fixture-private.pem',
    'auth.jwtPublicKeyPath': '/nonexistent/kheleo-fixture-public.pem',
    'app.nodeEnv': 'test',
    ...options.config,
  };
  const config = {
    get: (key: string, fallback?: unknown): unknown => settings[key] ?? fallback,
  } as unknown as ConfigService;
  const now = new Date();
  const user: TestUser = {
    id: TEST_USER_ID,
    phone: '+919000000001',
    email: 'athlete@fixture.test',
    role: UserRole.ATHLETE,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    identityRecord: null,
    athleteProfile: null,
    drillSubmissions: [],
    healthAlerts: [],
  };
  const state = {
    user,
    profile: null as TestProfile | null,
    token: {
      id: randomUUID(),
      userId: user.id,
      tokenHash: createHash('sha256').update('fixture-refresh-token').digest('hex'),
      family: 'fixture-family',
      revoked: false,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: now,
    } as RefreshToken,
    createdTokens: [] as RefreshToken[],
    createdIdentities: [] as IdentityVerification[],
    profileWrites: [] as ProfileWrite[],
    dossiers: new Map<string, ScoutDossier>(),
    auditLogs: [] as Prisma.SecurityAuditLogCreateInput[],
    profileQueries: [] as Prisma.AthleteProfileFindUniqueArgs[],
  };
  const findUser = (where: {
    readonly id?: string;
    readonly email?: string;
    readonly phone?: string;
  }): TestUser | null =>
    where.id === state.user.id ||
    where.email === state.user.email ||
    where.phone === state.user.phone
      ? state.user
      : null;
  const prisma = {
    user: {
      findUnique: async ({
        where,
      }: {
        readonly where: { readonly id?: string; readonly email?: string; readonly phone?: string };
      }): Promise<TestUser | null> => findUser(where),
      findUniqueOrThrow: async (): Promise<TestUser> => ({
        ...state.user,
        athleteProfile: state.profile
          ? { id: state.profile.id, currentGti: state.profile.currentGti }
          : null,
      }),
      findFirst: async ({
        where,
      }: {
        readonly where: {
          readonly OR: ReadonlyArray<{ readonly email?: string; readonly phone?: string }>;
        };
      }): Promise<TestUser | null> =>
        where.OR.some((entry) => findUser(entry)) ? state.user : null,
      update: async ({
        data,
      }: {
        readonly data: Readonly<Record<string, unknown>>;
      }): Promise<TestUser> => {
        assignDefined(state.user, data);
        return state.user;
      },
      create: async ({
        data,
      }: {
        readonly data: {
          readonly phone?: string;
          readonly email?: string;
          readonly role: UserRole;
          readonly isActive: boolean;
        };
      }): Promise<TestUser> => {
        state.user = {
          ...state.user,
          ...data,
          id: randomUUID(),
          phone: data.phone ?? null,
          email: data.email ?? null,
          identityRecord: null,
          athleteProfile: null,
        };
        return state.user;
      },
    },
    securityAuditLog: {
      create: async ({
        data,
      }: {
        data: Prisma.SecurityAuditLogCreateInput;
      }): Promise<Prisma.SecurityAuditLogCreateInput> => {
        state.auditLogs.push(data);
        return data;
      },
    },
    identityVerification: {
      findUnique: async ({
        where,
      }: {
        readonly where: { readonly idHash?: string; readonly userId?: string };
      }): Promise<(IdentityVerification & { readonly user: TestUser }) | null> => {
        const record = state.user.identityRecord;
        return record && (where.idHash === record.idHash || where.userId === record.userId)
          ? { ...record, user: state.user }
          : null;
      },
      update: async (): Promise<IdentityVerification | null> => state.user.identityRecord,
      create: async ({
        data,
      }: {
        readonly data: Pick<
          IdentityVerification,
          'userId' | 'idHash' | 'idType' | 'saltVersion' | 'status'
        >;
      }): Promise<IdentityVerification> => {
        const record: IdentityVerification = {
          ...data,
          id: randomUUID(),
          reLinkedCount: 0,
          historicalUserIds: [],
          verifiedAt: new Date(),
          metadata: null,
        };
        state.user.identityRecord = record;
        state.createdIdentities.push(record);
        return record;
      },
    },
    refreshToken: {
      findUnique: async ({
        where,
      }: {
        readonly where: { readonly tokenHash: string };
      }): Promise<(RefreshToken & { readonly user: TestUser }) | null> => {
        const token = [state.token, ...state.createdTokens].find(
          (entry) => entry.tokenHash === where.tokenHash,
        );
        return token ? { ...token, user: state.user } : null;
      },
      updateMany: async (): Promise<{ readonly count: number }> => {
        state.token.revoked = true;
        return { count: 1 };
      },
      create: async ({
        data,
      }: {
        readonly data: Omit<RefreshToken, 'id' | 'createdAt'>;
      }): Promise<RefreshToken> => {
        const token: RefreshToken = { ...data, id: randomUUID(), createdAt: new Date() };
        state.createdTokens.push(token);
        return token;
      },
    },
    athleteProfile: {
      findUnique: async (
        args: Prisma.AthleteProfileFindUniqueArgs,
      ): Promise<TestProfile | null> => {
        state.profileQueries.push(args);
        return state.profile;
      },
      findUniqueOrThrow: async (): Promise<TestProfile> => {
        if (!state.profile) throw new Error('Fixture passport was not initialized');
        return state.profile;
      },
      upsert: async (args: ProfileWrite): Promise<TestProfile> => {
        state.profileWrites.push(args);
        if (!state.profile) state.profile = makeProfile(state.user);
        assignDefined(
          state.profile,
          state.user.athleteProfile ? (args.update ?? {}) : (args.create ?? {}),
        );
        state.user.athleteProfile = { id: state.profile.id, currentGti: state.profile.currentGti };
        state.profile.user = state.user;
        return state.profile;
      },
      update: async ({ data }: ProfileWrite): Promise<TestProfile> => {
        if (!state.profile) throw new Error('Fixture passport was not initialized');
        assignDefined(state.profile, data ?? {});
        return state.profile;
      },
    },
    sportPassportRecord: {
      upsert: async (args: SportWrite): Promise<SportPassportRecord> => {
        if (!state.profile) throw new Error('Fixture passport was not initialized');
        const existing = state.profile.sportRecords.find(
          (record) => record.sport === args.where.athleteId_sport.sport,
        );
        if (existing) {
          assignDefined(existing, args.update);
          return existing;
        }
        const record: SportPassportRecord = {
          id: randomUUID(),
          athleteId: state.profile.id,
          sport: args.where.athleteId_sport.sport,
          primaryRole: 'GENERAL_ATHLETE',
          secondaryRoles: [],
          totalMatches: 0,
          winCount: 0,
          winStreak: 0,
          verifiedMetrics: {},
          earnedBadges: [],
          updatedAt: new Date(),
        };
        assignDefined(record, args.create);
        state.profile.sportRecords.push(record);
        return record;
      },
      findMany: async (): Promise<SportPassportRecord[]> => state.profile?.sportRecords ?? [],
    },
    scoutDossier: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        readonly where: {
          readonly athleteId_scoutId: { readonly athleteId: string; readonly scoutId: string };
        };
        readonly create: Readonly<Record<string, unknown>>;
        readonly update: Readonly<Record<string, unknown>>;
      }): Promise<ScoutDossier> => {
        const compound = where.athleteId_scoutId;
        const key = `${compound.athleteId}:${compound.scoutId}`;
        const previous = state.dossiers.get(key);
        const dossier: ScoutDossier = previous ?? {
          id: randomUUID(),
          ...compound,
          scoutNotes: '',
          federationTag: null,
          isShortlisted: false,
          pipelineStatus: 'DISCOVERED',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        assignDefined(dossier, previous ? update : create);
        state.dossiers.set(key, dossier);
        return dossier;
      },
    },
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>): Promise<unknown> =>
      operation(prisma),
  };
  const database = prisma as unknown as PrismaService;
  const identity = new IdentityService(database, config);
  state.user.identityRecord = {
    id: randomUUID(),
    userId: user.id,
    idHash: identity.hashGovernmentId(
      TEST_DOCUMENT,
      GovIdType.AADHAAR,
      options.storedSaltVersion ?? options.saltVersion ?? 1,
    ),
    idType: GovIdType.AADHAAR,
    saltVersion: options.storedSaltVersion ?? options.saltVersion ?? 1,
    status: VerificationStatus.VERIFIED,
    reLinkedCount: 0,
    historicalUserIds: [],
    verifiedAt: now,
    metadata: null,
  };
  const auth = new AuthService(database, identity, config);
  const passports = new PassportService(database);
  const dossiers = new ScoutsDossiersService(database);
  return {
    state,
    config,
    database,
    identity,
    auth,
    passports,
    dossiers,
    redis: new FixtureRedis(),
  };
}

function makeProfile(user: TestUser): TestProfile {
  return {
    id: randomUUID(),
    userId: user.id,
    dateOfBirth: null,
    gender: null,
    primarySport: null,
    secondarySports: [],
    district: '',
    state: '',
    tierClassification: TierClassification.RURAL,
    heightCm: null,
    weightKg: null,
    dominantSide: null,
    locationLat: null,
    locationLng: null,
    currentGti: new Prisma.Decimal(30),
    gti: 0,
    biomechanicalScore: 0,
    trainingConsistencyScore: 0,
    matchPerformanceScore: 0,
    isRuralOrUnderrepresented: false,
    posturePoints: 0,
    wearableScore: new Prisma.Decimal(50),
    matchPerfScore: new Prisma.Decimal(50),
    isScoutSearchable: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    user,
    sportRecords: [],
    gtiHistories: [],
  };
}

@Module({})
class AuthPassportTestModule {}

export async function createAuthPassportApp(
  fixture: ReturnType<typeof createAuthFixture>,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: AuthPassportTestModule,
      controllers: [AuthController, UsersController, PassportController, ScoutsController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        IdempotencyInterceptor,
        ScoutOutreachGuard,
        { provide: ConfigService, useValue: fixture.config },
        { provide: PrismaService, useValue: fixture.database },
        { provide: RedisService, useValue: fixture.redis },
        { provide: AuthService, useValue: fixture.auth },
        { provide: PassportService, useValue: fixture.passports },
        { provide: ScoutsDossiersService, useValue: fixture.dossiers },
        { provide: UsersService, useValue: new UsersService(fixture.database) },
        { provide: ScoutsService, useValue: new ScoutsService(fixture.database) },
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

export function fixtureToken(role: UserRole = UserRole.ATHLETE, sub = TEST_USER_ID): string {
  return sign({ sub, role }, TEST_SECRET, { expiresIn: 900, algorithm: 'HS256' });
}
