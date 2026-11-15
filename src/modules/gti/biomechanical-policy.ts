import { Prisma } from '@prisma/client';

/** Component points on the 0–100 scale, independent of the 35% composite weight. */
export const UNCONNECTED_BIOMECHANICAL_CAP = 35;
export const WATCH_TELEMETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function biomechanicalScoreForWatch(score: number, qualified: boolean): number {
  const measured = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  return qualified ? measured : Math.min(UNCONNECTED_BIOMECHANICAL_CAP, measured);
}

export interface AthleteScorePolicy {
  userId: string;
  gti: number;
  biomechanicalScore: number;
  watchQualified: boolean;
  watchExpiresAt: number | null;
  calculationMode: 'ONBOARDING_BASELINE' | 'WEIGHTED';
}

/** The database view also covers existing accounts and expired hardware evidence. */
export async function loadAthleteScorePolicies(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userIds: readonly string[],
): Promise<Map<string, AthleteScorePolicy>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.$queryRaw<AthleteScorePolicy[]>(Prisma.sql`
    SELECT user_id AS "userId", effective_gti AS gti,
      effective_biomechanical_score AS "biomechanicalScore",
      watch_qualified AS "watchQualified", calculation_mode AS "calculationMode"
      , (EXTRACT(EPOCH FROM (latest_hardware_at + INTERVAL '24 hours'))*1000)::float8 AS "watchExpiresAt"
    FROM athlete_score_policy WHERE user_id IN (${Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`))})
  `);
  return new Map(rows.map((row) => [row.userId, row]));
}
