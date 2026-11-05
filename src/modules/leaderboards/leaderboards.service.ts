import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma, SportType, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import {
  LeaderboardCursor,
  LeaderboardEntry,
  LeaderboardPage,
  LeaderboardsQueryDto,
  LeaderboardScope,
} from './leaderboards.dto';

@Injectable()
export class LeaderboardsService {
  private readonly logger = new Logger(LeaderboardsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async syncAthlete(
    userId: string,
    previous?: { primarySport: SportType | null; state: string; district: string } | null,
  ): Promise<void> {
    try {
      const profile = await this.prisma.athleteProfile.findUnique({
        where: { userId },
        include: { user: { include: { identityRecord: true } } },
      });
      const membershipKey = `leaderboard:memberships:${userId}`;
      // The Lua update atomically removes old geography/sport memberships and writes the current ones.
      const keysFor = (
        value:
          | { primarySport: SportType | null; state: string; district: string }
          | null
          | undefined,
      ): string[] =>
        value?.primarySport
          ? [
              `leaderboard:global:${value.primarySport}`,
              `leaderboard:state:${value.state}:${value.primarySport}`,
              `leaderboard:district:${value.district}:${value.primarySport}`,
              `leaderboard:district:${value.state}:${value.district}:${value.primarySport}`,
            ]
          : [];
      const keys =
        profile &&
        profile.primarySport &&
        profile.isScoutSearchable &&
        profile.user.isActive &&
        profile.user.role === 'ATHLETE' &&
        profile.user.identityRecord?.status === VerificationStatus.VERIFIED
          ? keysFor(profile)
          : [];
      await this.redis.client.eval(
        `
        local old = redis.call('SMEMBERS', KEYS[1])
        for _, key in ipairs(old) do redis.call('ZREM', key, ARGV[1]) end
        for _, key in ipairs(cjson.decode(ARGV[3])) do redis.call('ZREM', key, ARGV[1]) end
        redis.call('DEL', KEYS[1])
        for _, key in ipairs(cjson.decode(ARGV[4])) do
          redis.call('ZADD', key, ARGV[2], ARGV[1])
          redis.call('SADD', KEYS[1], key)
        end
        return 1`,
        1,
        membershipKey,
        userId,
        profile ? profile.gti || Number(profile.currentGti) : 0,
        JSON.stringify([...keysFor(profile), ...keysFor(previous)]),
        JSON.stringify(keys),
      );
    } catch (error: unknown) {
      this.logger.warn(`Leaderboard cache sync failed for ${userId}: ${String(error)}`);
    }
  }

  private key(query: LeaderboardsQueryDto): string {
    if (query.scope !== LeaderboardScope.NATIONAL && !query.state?.trim())
      throw new BadRequestException('state is required for STATE and DISTRICT scopes');
    if (query.scope === LeaderboardScope.DISTRICT && !query.district?.trim())
      throw new BadRequestException('district is required for DISTRICT scope');
    return query.scope === LeaderboardScope.NATIONAL
      ? `leaderboard:global:${query.sport}`
      : query.scope === LeaderboardScope.STATE
        ? `leaderboard:state:${query.state}:${query.sport}`
        : `leaderboard:district:${query.state}:${query.district}:${query.sport}`;
  }
  private cursor(raw: string | undefined, scope: string): LeaderboardCursor | undefined {
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('id' in parsed) ||
        typeof parsed.id !== 'string' ||
        !isUUID(parsed.id) ||
        !('score' in parsed) ||
        typeof parsed.score !== 'number' ||
        !Number.isFinite(parsed.score) ||
        parsed.score < 0 ||
        parsed.score > 100 ||
        !('scope' in parsed) ||
        parsed.scope !== scope
      )
        throw new Error('Invalid cursor');
      return { id: parsed.id, score: parsed.score, scope };
    } catch {
      throw new BadRequestException('Invalid leaderboard cursor for this scope');
    }
  }
  private page(
    rows: LeaderboardEntry[],
    limit: number,
    scope: string,
    source: LeaderboardPage['source'],
  ): LeaderboardPage {
    const data = rows.slice(0, limit).map((row) => ({ ...row, rank: Number(row.rank) }));
    const last = data.at(-1);
    return {
      data,
      source,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ id: last.athleteId, score: last.gti, scope })).toString(
              'base64url',
            )
          : null,
    };
  }

  async list(query: LeaderboardsQueryDto): Promise<LeaderboardPage> {
    const key = this.key(query);
    const cursor = this.cursor(query.cursor, key);
    const where: Prisma.AthleteProfileWhereInput = {
      primarySport: query.sport,
      isScoutSearchable: true,
      user: { role: 'ATHLETE', isActive: true, identityRecord: { status: 'VERIFIED' } },
      ...(query.scope !== LeaderboardScope.NATIONAL ? { state: query.state } : {}),
      ...(query.scope === LeaderboardScope.DISTRICT ? { district: query.district } : {}),
    };
    try {
      const [cachedCount, eligibleCount] = await Promise.all([
        this.redis.client.zcard(key),
        this.prisma.athleteProfile.count({ where }),
      ]);
      if (cachedCount !== eligibleCount) throw new Error('Leaderboard cache is incomplete');
      let offset = 0;
      if (cursor) {
        const [rank, score] = await Promise.all([
          this.redis.client.zrevrank(key, cursor.id),
          this.redis.client.zscore(key, cursor.id),
        ]);
        if (rank === null || Number(score) !== cursor.score)
          throw new Error('Cursor moved in cache');
        offset = rank + 1;
      }
      const raw = await this.redis.client.zrevrange(
        key,
        offset,
        offset + query.limit,
        'WITHSCORES',
      );
      const ids = raw.filter((_value, index) => index % 2 === 0);
      const profiles = await this.prisma.athleteProfile.findMany({
        where: { AND: [where, { userId: { in: ids } }] },
      });
      const byId = new Map(profiles.map((profile) => [profile.userId, profile]));
      const entries: LeaderboardEntry[] = ids.map((id, index) => {
        const profile = byId.get(id);
        const score = Number(raw[index * 2 + 1]);
        if (!profile || (profile.gti || Number(profile.currentGti)) !== score)
          throw new Error('Leaderboard cache is stale');
        return {
          rank: offset + index + 1,
          athleteId: id,
          district: profile.district,
          state: profile.state,
          sport: query.sport,
          gti: score,
          biomechanicalScore: profile.biomechanicalScore,
          wearableScore: profile.trainingConsistencyScore,
          matchPerformanceScore: profile.matchPerformanceScore,
        };
      });
      return this.page(entries, query.limit, key, 'redis');
    } catch (error: unknown) {
      this.logger.debug(`Reading leaderboard from database: ${String(error)}`);
    }
    const state =
      query.scope === LeaderboardScope.NATIONAL
        ? Prisma.empty
        : Prisma.sql`AND p.state = ${query.state}`;
    const district =
      query.scope !== LeaderboardScope.DISTRICT
        ? Prisma.empty
        : Prisma.sql`AND p.district = ${query.district}`;
    const after = cursor
      ? Prisma.sql`WHERE (gti, "athleteId") < (${cursor.score}::float8, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<LeaderboardEntry[]>(Prisma.sql`
      WITH ranked AS (
        SELECT ROW_NUMBER() OVER (ORDER BY COALESCE(NULLIF(p.gti, 0), p.current_gti, 0) DESC, p.user_id DESC)::int AS rank,
          p.user_id AS "athleteId", p.district, p.state, p.primary_sport AS sport,
          COALESCE(NULLIF(p.gti, 0), p.current_gti, 0)::float8 AS gti,
          p.biomechanical_score AS "biomechanicalScore", p.training_consistency_score AS "wearableScore", p.match_performance_score AS "matchPerformanceScore"
        FROM athlete_profiles p JOIN users u ON u.id = p.user_id JOIN identity_verifications i ON i.user_id = u.id
        WHERE p.primary_sport = ${query.sport}::"SportType" AND p.is_scout_searchable AND u.is_active AND u.role = 'ATHLETE' AND i.status = 'VERIFIED' ${state} ${district}
      ) SELECT * FROM ranked ${after} ORDER BY gti DESC, "athleteId" DESC LIMIT ${query.limit + 1}`);
    return this.page(rows, query.limit, key, 'database');
  }

  async rank(sport: SportType, athleteId: string, district?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ rank: number }>>(Prisma.sql`
      WITH ranked AS (
        SELECT p.user_id, ROW_NUMBER() OVER (ORDER BY COALESCE(NULLIF(p.gti,0),p.current_gti,0) DESC,p.user_id DESC)::int AS rank
        FROM athlete_profiles p JOIN users u ON u.id=p.user_id JOIN identity_verifications i ON i.user_id=u.id
        WHERE p.primary_sport=${sport}::"SportType" AND p.is_scout_searchable AND u.is_active AND u.role='ATHLETE' AND i.status='VERIFIED' ${district ? Prisma.sql`AND p.district=${district}` : Prisma.empty}
      ) SELECT rank FROM ranked WHERE user_id=${athleteId}::uuid`);
    return rows[0]?.rank ?? null;
  }
}
