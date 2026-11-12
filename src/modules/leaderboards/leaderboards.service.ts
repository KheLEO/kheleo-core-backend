import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma, SportType, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import {
  bumpVersion,
  CACHE_KEYS,
  invalidateCacheKeys,
  readThroughCache,
  readVersion,
} from '../../infrastructure/cache/cache-helper';
import { normalizeLocationName } from '../../common/constants/india-locations';
import {
  LeaderboardCursor,
  LeaderboardRow,
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
    requireDelivery = false,
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
          { primarySport: SportType | null; state: string; district: string } | null | undefined,
      ): string[] => {
        if (!value?.primarySport) return [];
        const state = normalizeLocationName(value.state);
        const district = normalizeLocationName(value.district);
        return [
          `leaderboard:global:ALL`,
          `leaderboard:state:${state}:ALL`,
          `leaderboard:district:${state}:${district}:ALL`,
          `leaderboard:global:${value.primarySport}`,
          `leaderboard:state:${state}:${value.primarySport}`,
          `leaderboard:district:${district}:${value.primarySport}`,
          `leaderboard:district:${state}:${district}:${value.primarySport}`,
        ];
      };
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
      await bumpVersion(this.redis, CACHE_KEYS.leaderboardVersion());
      await invalidateCacheKeys(this.redis, [
        CACHE_KEYS.passport(userId),
        CACHE_KEYS.regionalHeatmap(),
      ]);
    } catch (error: unknown) {
      if (requireDelivery) throw error;
      this.logger.warn(`Leaderboard cache sync failed for ${userId}: ${String(error)}`);
    }
  }

  private key(query: LeaderboardsQueryDto): string {
    if (query.scope !== LeaderboardScope.NATIONAL && !query.state?.trim())
      throw new BadRequestException('state is required for STATE and DISTRICT scopes');
    if (query.scope === LeaderboardScope.DISTRICT && !query.district?.trim())
      throw new BadRequestException('district is required for DISTRICT scope');
    const state = query.state ? normalizeLocationName(query.state) : '';
    const district = query.district ? normalizeLocationName(query.district) : '';
    return query.scope === LeaderboardScope.NATIONAL
      ? `leaderboard:global:${query.sport ?? 'ALL'}`
      : query.scope === LeaderboardScope.STATE
        ? `leaderboard:state:${state}:${query.sport ?? 'ALL'}`
        : `leaderboard:district:${state}:${district}:${query.sport ?? 'ALL'}`;
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
    rows: LeaderboardRow[],
    query: LeaderboardsQueryDto,
    scopeKey: string,
    total: number,
    source: LeaderboardPage['source'],
  ): LeaderboardPage {
    const data = rows.slice(0, query.limit).map((row) => ({
      ...row,
      rank: Number(row.rank),
      athlete_id: row.athleteId,
      profile_id: row.profileId,
      display_name: `Athlete ${row.athleteId.slice(0, 8)}`,
      tier_classification: row.tierClassification,
      primary_sport: row.sport,
      primary_role: row.primaryRole,
      biomechanical_score: row.biomechanicalScore,
      wearable_consistency_score: row.wearableScore,
      match_performance_score: row.matchPerformanceScore,
      total_matches: Number(row.totalMatches),
      win_rate: row.totalMatches ? Number(((100 * row.winCount) / row.totalMatches).toFixed(2)) : 0,
    }));
    const last = data.at(-1);
    const hasMore = rows.length > query.limit;
    return {
      success: true,
      scope: query.scope,
      total,
      data,
      source,
      has_more: hasMore,
      next_cursor: hasMore && last ? last.profile_id : null,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ id: last.athleteId, score: last.gti, scope: scopeKey }),
            ).toString('base64url')
          : null,
    };
  }

  private locationVariants(raw?: string, normalized?: string): string[] {
    const base = [raw, normalized].filter((value): value is string => Boolean(value?.trim()));
    const expanded = base.flatMap((value) => {
      const trimmed = value.trim().toLowerCase();
      return [trimmed, trimmed.replaceAll('-', ' '), trimmed.replaceAll(' ', '-')];
    });
    return [...new Set(expanded)];
  }

  async list(query: LeaderboardsQueryDto): Promise<LeaderboardPage> {
    const key = this.key(query);
    const filtered = query.tier === 'RURAL_AND_TIER_2_3' || Boolean(query.gender);
    const scopeKey = filtered ? `${key}:${query.tier ?? 'ALL'}:${query.gender ?? ''}` : key;
    if (query.cursor && query.cursor_id)
      throw new BadRequestException('Use one leaderboard cursor');
    const normalizedState = query.state ? normalizeLocationName(query.state) : undefined;
    const normalizedDistrict = query.district ? normalizeLocationName(query.district) : undefined;
    const where: Prisma.AthleteProfileWhereInput = {
      primarySport: query.sport && query.sport !== 'ALL' ? query.sport : { not: null },
      isScoutSearchable: true,
      user: { role: 'ATHLETE', isActive: true, identityRecord: { status: 'VERIFIED' } },
      ...(query.scope !== LeaderboardScope.NATIONAL
        ? {
            state: normalizedState
              ? { in: [query.state!, normalizedState], mode: 'insensitive' }
              : query.state,
          }
        : {}),
      ...(query.scope === LeaderboardScope.DISTRICT
        ? {
            district: normalizedDistrict
              ? { in: [query.district!, normalizedDistrict], mode: 'insensitive' }
              : query.district,
          }
        : {}),
      ...(query.tier === 'RURAL_AND_TIER_2_3'
        ? {
            OR: [
              { isRuralOrUnderrepresented: true },
              { tierClassification: { in: ['RURAL', 'TIER_2', 'TIER_3'] } },
            ],
          }
        : {}),
      ...(query.gender ? { gender: { equals: query.gender, mode: 'insensitive' } } : {}),
    };
    let cursor = this.cursor(query.cursor, scopeKey);
    if (query.cursor_id) {
      const profile = await this.prisma.athleteProfile.findFirst({
        where: { AND: [where, { id: query.cursor_id }] },
        select: { userId: true, gti: true, currentGti: true },
      });
      if (!profile) throw new BadRequestException('Cursor athlete is outside this leaderboard');
      cursor = {
        id: profile.userId,
        score: profile.gti || Number(profile.currentGti),
        scope: scopeKey,
      };
    }
    try {
      if (filtered) throw new Error('Demographic ranks use the database');
      const ver = await readVersion(this.redis, CACHE_KEYS.leaderboardVersion());
      const pageCacheKey = CACHE_KEYS.leaderboardPage(
        ver,
        scopeKey,
        query.cursor ?? query.cursor_id,
        query.limit,
      );
      return await readThroughCache(this.redis, pageCacheKey, 20, async () => {
        const cachedTotal = await this.redis.client.zcard(key);
        if (cachedTotal === 0) throw new Error('Leaderboard cache is empty');
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
        if (ids.length === 0) {
          return this.page([], query, scopeKey, cachedTotal, 'redis');
        }
        const profiles = await this.prisma.athleteProfile.findMany({
          where: { AND: [where, { userId: { in: ids } }] },
          select: {
            id: true,
            userId: true,
            district: true,
            state: true,
            primarySport: true,
            gti: true,
            currentGti: true,
            biomechanicalScore: true,
            trainingConsistencyScore: true,
            matchPerformanceScore: true,
            gender: true,
            tierClassification: true,
            sportRecords: {
              ...(query.sport && query.sport !== 'ALL' ? { where: { sport: query.sport } } : {}),
              select: {
                sport: true,
                primaryRole: true,
                totalMatches: true,
                winCount: true,
              },
            },
          },
        });
        const byId = new Map(profiles.map((profile) => [profile.userId, profile]));
        const entries: LeaderboardRow[] = ids.map((id, index) => {
          const profile = byId.get(id);
          const score = Number(raw[index * 2 + 1]);
          if (!profile || (profile.gti || Number(profile.currentGti)) !== score)
            throw new Error('Leaderboard cache is stale');
          const record = profile.sportRecords?.find((entry) => entry.sport === profile.primarySport);
          return {
            rank: offset + index + 1,
            athleteId: id,
            profileId: profile.id,
            district: profile.district,
            state: profile.state,
            sport: profile.primarySport!,
            gti: score,
            biomechanicalScore: profile.biomechanicalScore,
            wearableScore: profile.trainingConsistencyScore,
            matchPerformanceScore: profile.matchPerformanceScore,
            gender: profile.gender,
            tierClassification: profile.tierClassification,
            primaryRole: record?.primaryRole ?? null,
            totalMatches: record?.totalMatches ?? 0,
            winCount: record?.winCount ?? 0,
          };
        });
        return this.page(entries, query, scopeKey, cachedTotal, 'redis');
      });
    } catch (error: unknown) {
      this.logger.debug(`Reading leaderboard from database: ${String(error)}`);
    }
    const stateVariants =
      query.scope === LeaderboardScope.NATIONAL
        ? []
        : this.locationVariants(query.state, normalizedState);
    const state =
      query.scope === LeaderboardScope.NATIONAL || stateVariants.length === 0
        ? Prisma.empty
        : Prisma.sql`AND lower(p.state) IN (${Prisma.join(stateVariants)})`;
    const districtVariants =
      query.scope !== LeaderboardScope.DISTRICT
        ? []
        : this.locationVariants(query.district, normalizedDistrict);
    const district =
      query.scope !== LeaderboardScope.DISTRICT || districtVariants.length === 0
        ? Prisma.empty
        : Prisma.sql`AND lower(p.district) IN (${Prisma.join(districtVariants)})`;
    const sport =
      query.sport && query.sport !== 'ALL'
        ? Prisma.sql`AND p.primary_sport = ${query.sport}::"SportType"`
        : Prisma.empty;
    const gender = query.gender
      ? Prisma.sql`AND UPPER(p.gender) = UPPER(${query.gender})`
      : Prisma.empty;
    const tier =
      query.tier === 'RURAL_AND_TIER_2_3'
        ? Prisma.sql`AND (p.is_rural_or_underrepresented OR p.tier_classification IN ('RURAL','TIER_2','TIER_3'))`
        : Prisma.empty;
    const after = cursor
      ? Prisma.sql`WHERE (gti, "athleteId") < (${cursor.score}::float8, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rawRows = await this.prisma.$queryRaw<Array<LeaderboardRow & { totalCount?: number }>>(Prisma.sql`
      WITH ranked AS (
        SELECT ROW_NUMBER() OVER (ORDER BY COALESCE(NULLIF(p.gti, 0), p.current_gti, 0) DESC, p.user_id DESC)::int AS rank,
          COUNT(*) OVER()::int AS "totalCount",
          p.user_id AS "athleteId", p.id AS "profileId", p.district, p.state, p.primary_sport AS sport, p.gender,
          p.tier_classification AS "tierClassification", r.primary_role AS "primaryRole",
          COALESCE(r.total_matches,0)::int AS "totalMatches", COALESCE(r.win_count,0)::int AS "winCount",
          COALESCE(NULLIF(p.gti, 0), p.current_gti, 0)::float8 AS gti,
          p.biomechanical_score AS "biomechanicalScore", p.training_consistency_score AS "wearableScore", p.match_performance_score AS "matchPerformanceScore"
        FROM athlete_profiles p JOIN users u ON u.id = p.user_id JOIN identity_verifications i ON i.user_id = u.id
        LEFT JOIN sport_passport_records r ON r.athlete_id = p.id AND r.sport = p.primary_sport
        WHERE p.primary_sport IS NOT NULL AND p.is_scout_searchable AND u.is_active AND u.role = 'ATHLETE' AND i.status = 'VERIFIED'
          ${sport} ${state} ${district} ${gender} ${tier}
      ) SELECT * FROM ranked ${after} ORDER BY gti DESC, "athleteId" DESC LIMIT ${query.limit + 1}`);
    const total = Number(rawRows[0]?.totalCount ?? 0);
    const rows: LeaderboardRow[] = rawRows.map(({ totalCount: _tc, ...rest }) => rest);
    return this.page(rows, query, scopeKey, total, 'database');
  }

  async rank(sport: SportType, athleteId: string, district?: string): Promise<number | null> {
    const normalizedDistrict = district ? normalizeLocationName(district) : undefined;
    const districtVariants = district ? this.locationVariants(district, normalizedDistrict) : [];
    const districtFilter =
      districtVariants.length > 0
        ? Prisma.sql`AND lower(p.district) IN (${Prisma.join(districtVariants)})`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ rank: number }>>(Prisma.sql`
      WITH ranked AS (
        SELECT p.user_id, ROW_NUMBER() OVER (ORDER BY COALESCE(NULLIF(p.gti,0),p.current_gti,0) DESC,p.user_id DESC)::int AS rank
        FROM athlete_profiles p JOIN users u ON u.id=p.user_id JOIN identity_verifications i ON i.user_id=u.id
        WHERE p.primary_sport=${sport}::"SportType" AND p.is_scout_searchable AND u.is_active AND u.role='ATHLETE' AND i.status='VERIFIED' ${districtFilter}
      ) SELECT rank FROM ranked WHERE user_id=${athleteId}::uuid`);
    return rows[0]?.rank ?? null;
  }
}
