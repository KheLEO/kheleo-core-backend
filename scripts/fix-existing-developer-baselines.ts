import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  GtiReconciliationSummary,
  prismaReconciliationDb,
  reconcileGtiRecords,
  ReconcileSqlDb,
} from './reconcile-gti-scores';

export interface CorrectionResult {
  readonly mode: 'PRISMA_DATABASE' | 'SIMULATED_VERIFICATION';
  readonly dryRun: boolean;
  readonly totalScanned: number;
  readonly eligibleCount: number;
  readonly correctedCount: number;
  readonly remainingAtZero: number;
  readonly invalidatedCacheCount: number;
  readonly correctedAccounts: Array<{
    readonly profileId: string;
    readonly userId: string;
    readonly previousCurrentGti: number;
    readonly newCurrentGti: number;
    readonly previousWearableScore: number;
    readonly newWearableScore: number;
    readonly previousMatchPerfScore: number;
    readonly newMatchPerfScore: number;
    readonly updated: boolean;
  }>;
}

export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  return trimmed.length <= 4 ? '***' : trimmed.slice(0, 3) + '*****' + trimmed.slice(-4);
}

function correctionResult(
  summary: GtiReconciliationSummary,
  mode: CorrectionResult['mode'],
  apply: boolean,
  remainingAtZero: number,
  invalidatedCacheCount: number,
): CorrectionResult {
  const eligible = summary.affected.filter((entry) => entry.eligibleForUpdate);
  return {
    mode,
    dryRun: !apply,
    totalScanned: summary.totalProfilesScanned,
    eligibleCount: eligible.length,
    correctedCount: summary.updatedCount,
    remainingAtZero,
    invalidatedCacheCount,
    correctedAccounts: eligible.map((entry) => ({
      profileId: entry.profileId,
      userId: entry.userId,
      previousCurrentGti: entry.existingCurrentGti,
      newCurrentGti: entry.proposedScores.currentGti,
      previousWearableScore: entry.existingWearableScore,
      newWearableScore: entry.proposedScores.wearableScore,
      previousMatchPerfScore: entry.existingMatchPerfScore,
      newMatchPerfScore: entry.proposedScores.matchPerfScore,
      updated: entry.updated,
    })),
  };
}

export async function fixBaselinesWithPrisma(
  prisma: PrismaClient,
  options: { readonly apply?: boolean } = {},
): Promise<CorrectionResult> {
  const apply = options.apply ?? false;
  // Reads, evidence qualification, and all four score writes share one Serializable Prisma transaction.
  const summary = await reconcileGtiRecords(prismaReconciliationDb(prisma), {
    apply,
    baselineOnly: true,
  });
  const updatedIds = summary.affected.filter((entry) => entry.updated).map((entry) => entry.userId);
  const invalidated = updatedIds.length ? await invalidateRedisPassportCaches(updatedIds) : 0;
  const remaining = await prisma.athleteProfile.count({ where: { currentGti: { lte: 0 } } });
  return correctionResult(summary, 'PRISMA_DATABASE', apply, remaining, invalidated);
}

export async function invalidateRedisPassportCaches(userIds: string[]): Promise<number> {
  if (!process.env.REDIS_HOST && !process.env.REDIS_URL) return 0;
  const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
      })
    : new Redis({
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT || 6379),
        username: process.env.REDIS_USERNAME || undefined,
        password: process.env.REDIS_PASSWORD || undefined,
        db: Number(process.env.REDIS_DB || 0),
        ...(process.env.REDIS_TLS === 'true' ? { tls: { rejectUnauthorized: true } } : {}),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
      });
  try {
    await redis.connect();
    await redis.del(
      ...userIds.flatMap((id) => [`passport:v1:${id}`, `auth:v1:user:${id}`]),
      'heatmap:v1:regional',
    );
    await redis.incr('leaderboard:v1:ver');
    return userIds.length;
  } catch (error: unknown) {
    console.warn(`[Redis] Post-commit cache invalidation failed: ${String(error)}`);
    return 0;
  } finally {
    redis.disconnect();
  }
}

export async function fixBaselinesWithPGlite(
  options: { readonly apply?: boolean } = {},
): Promise<CorrectionResult> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const db = new PGlite('memory://', { extensions: { postgis } });
  try {
    const root = resolve(__dirname, '../prisma/migrations');
    for (const dir of readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await db.exec(readFileSync(resolve(root, dir.name, 'migration.sql'), 'utf8'));
    }
    const uid = randomUUID();
    await db.query('INSERT INTO users(id, updated_at) VALUES($1, now())', [uid]);
    await db.query(
      "INSERT INTO athlete_profiles(id,user_id,district,state,current_gti,wearable_score,match_perf_score,updated_at) VALUES($1,$2,'Pune','Maharashtra',0,50,50,now())",
      [randomUUID(), uid],
    );
    const adapter: ReconcileSqlDb = {
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        db.query<T>(sql, params),
      transaction: (operation) =>
        db.transaction((tx) =>
          operation({
            query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
              tx.query<T>(sql, params),
          }),
        ),
    };
    const apply = options.apply ?? false;
    const summary = await reconcileGtiRecords(adapter, { apply, baselineOnly: true });
    const remaining = (
      await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM athlete_profiles WHERE current_gti<=0',
      )
    ).rows[0]!.count;
    return correctionResult(summary, 'SIMULATED_VERIFICATION', apply, remaining, 0);
  } finally {
    await db.close();
  }
}

export async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  let result: CorrectionResult;
  if (databaseUrl) {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      result = await fixBaselinesWithPrisma(prisma, { apply });
    } finally {
      await prisma.$disconnect();
    }
  } else {
    console.log(
      '[Notice] No database configured; demonstrating the repair on a memory-only synthetic fixture.',
    );
    result = await fixBaselinesWithPGlite({ apply });
  }
  console.log(JSON.stringify({ execution: apply ? 'APPLY' : 'DRY_RUN', ...result }, null, 2));
  // Measured athletes may legitimately remain at zero; that is not a repair failure.
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
