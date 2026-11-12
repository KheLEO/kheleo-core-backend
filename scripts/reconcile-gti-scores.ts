import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { evaluateGtiBreakdown } from '../src/modules/gti/gti-score-reconciliation';

export type GtiDriftCategory =
  | 'UNMEASURED_SYNTHETIC_BASELINE'
  | 'MATCH_ACTIVITY_BUG_0_NEQ_50'
  | 'COMPONENT_MIRROR_DRIFT'
  | 'COMPOSITE_GTI_DRIFT'
  | 'CUSTOM_LEGACY_SCORE_REVIEW';

export interface ReconcileSqlDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AffectedAthleteReport {
  readonly profileId: string;
  readonly userId: string;
  readonly primarySport: string | null;
  readonly categories: GtiDriftCategory[];
  readonly existingCurrentGti: number;
  readonly existingGti: number;
  readonly recalculatedGti: number;
  readonly legacyBuggyGti: number;
  readonly existingWearableScore: number;
  readonly authoritativeWearableScore: number;
  readonly existingMatchPerfScore: number;
  readonly authoritativeMatchPerfScore: number;
  readonly sportRankBefore: number | null;
  readonly sportRankAfter: number | null;
  readonly affectedRegistrations: Array<{
    readonly registrationId: string;
    readonly bracketId: string;
    readonly minGti: number;
    readonly maxGti: number;
    readonly eligibleBefore: boolean;
    readonly eligibleAfter: boolean;
  }>;
  readonly updated: boolean;
}

export interface GtiReconciliationSummary {
  readonly totalProfilesScanned: number;
  readonly affectedCount: number;
  readonly updatedCount: number;
  readonly customLegacyReviewCount: number;
  readonly eligibilityTransitions: number;
  readonly affected: AffectedAthleteReport[];
}

interface RawProfileAuditRow {
  id: string;
  user_id: string;
  primary_sport: string | null;
  gti: number;
  current_gti: string | number;
  biomechanical_score: number;
  training_consistency_score: number;
  match_performance_score: number;
  wearable_score: string | number;
  match_perf_score: string | number;
  drills_count: number | string;
  sessions_count: number | string;
  alerts_count: number | string;
  matches_count: number | string;
  total_passport_matches: number | string;
}

interface RegistrationBoundsRow {
  registration_id: string;
  user_id: string;
  bracket_id: string;
  min_gti: string | number;
  max_gti: string | number;
}

function rankBySport(
  rows: ReadonlyArray<{ userId: string; primarySport: string | null; score: number }>,
): Map<string, number> {
  const bySport = new Map<string, Array<{ userId: string; score: number }>>();
  for (const row of rows) {
    if (!row.primarySport) continue;
    const list = bySport.get(row.primarySport) ?? [];
    list.push({ userId: row.userId, score: row.score });
    bySport.set(row.primarySport, list);
  }
  const ranks = new Map<string, number>();
  for (const list of bySport.values()) {
    list.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.userId.localeCompare(b.userId)));
    list.forEach((entry, idx) => ranks.set(entry.userId, idx + 1));
  }
  return ranks;
}

export async function reconcileGtiRecords(
  db: ReconcileSqlDb,
  options: { readonly apply?: boolean; readonly resetUnmeasuredBaseline?: boolean } = {},
): Promise<GtiReconciliationSummary> {
  const apply = options.apply ?? false;
  const resetUnmeasuredBaseline = options.resetUnmeasuredBaseline ?? false;

  const { rows: profiles } = await db.query<RawProfileAuditRow>(`
    SELECT
      ap.id,
      ap.user_id,
      ap.primary_sport::text AS primary_sport,
      ap.gti,
      ap.current_gti,
      ap.biomechanical_score,
      ap.training_consistency_score,
      ap.match_performance_score,
      ap.wearable_score,
      ap.match_perf_score,
      (SELECT COUNT(*)::int FROM drill_submissions ds WHERE ds.athlete_id = ap.user_id) AS drills_count,
      (SELECT COUNT(*)::int FROM wearable_sessions ws WHERE ws.athlete_id = ap.user_id) AS sessions_count,
      (SELECT COUNT(*)::int FROM health_alerts ha WHERE ha.athlete_id = ap.user_id) AS alerts_count,
      (
        SELECT COUNT(*)::int
        FROM verified_match_results vmr
        JOIN brackets b ON b.id = vmr.bracket_id
        JOIN tournaments t ON t.id = b.tournament_id
        WHERE ap.user_id = ANY(vmr.participant_athlete_ids)
          AND (ap.primary_sport IS NULL OR t.sport = ap.primary_sport)
      ) AS matches_count,
      COALESCE((
        SELECT SUM(spr.total_matches)::int
        FROM sport_passport_records spr
        WHERE spr.athlete_id = ap.id
      ), 0) AS total_passport_matches
    FROM athlete_profiles ap
    ORDER BY ap.created_at ASC, ap.id ASC
  `);

  const { rows: registrations } = await db.query<RegistrationBoundsRow>(`
    SELECT
      r.id AS registration_id,
      r.user_id,
      r.bracket_id,
      b.min_gti,
      b.max_gti
    FROM registrations r
    JOIN brackets b ON b.id = r.bracket_id
    WHERE r.status IN ('PENDING', 'CONFIRMED')
  `);

  const regByUser = new Map<string, RegistrationBoundsRow[]>();
  for (const reg of registrations) {
    const list = regByUser.get(reg.user_id) ?? [];
    list.push(reg);
    regByUser.set(reg.user_id, list);
  }

  const evaluations = profiles.map((p) => {
    const existingCurrentGti = Number(p.current_gti);
    const existingGti = Number(p.gti);
    const existingWearableScore = Number(p.wearable_score);
    const existingMatchPerfScore = Number(p.match_perf_score);
    const authoritativeWearable = Number(p.training_consistency_score);
    const authoritativeMatch = Number(p.match_performance_score);
    const biomechanical = Number(p.biomechanical_score);

    const commonInput = {
      biomechanicalScore: biomechanical,
      wearableScore: authoritativeWearable,
      matchPerformanceScore: authoritativeMatch,
      drillsCount: Number(p.drills_count),
      sessionsCount: Number(p.sessions_count),
      healthAlertsCount: Number(p.alerts_count),
      matchesCount: Number(p.matches_count),
      totalPassportMatches: Number(p.total_passport_matches),
    };

    const reconciled = evaluateGtiBreakdown({ ...commonInput, legacyMatchActivityCheck: false });
    const legacyBuggy = evaluateGtiBreakdown({ ...commonInput, legacyMatchActivityCheck: true });

    const categories: GtiDriftCategory[] = [];
    const hasAnyEvidence =
      commonInput.drillsCount > 0 ||
      commonInput.sessionsCount > 0 ||
      commonInput.healthAlertsCount > 0 ||
      commonInput.matchesCount > 0 ||
      commonInput.totalPassportMatches > 0 ||
      biomechanical > 0 ||
      authoritativeWearable > 0 ||
      authoritativeMatch > 0;

    if (
      !hasAnyEvidence &&
      (existingCurrentGti === 30 || existingWearableScore === 50 || existingMatchPerfScore === 50)
    ) {
      categories.push('UNMEASURED_SYNTHETIC_BASELINE');
    }
    if (
      commonInput.drillsCount === 0 &&
      commonInput.sessionsCount === 0 &&
      ((authoritativeWearable === 0 && existingWearableScore > 0 && existingWearableScore !== 50) ||
        (authoritativeMatch === 0 && existingMatchPerfScore > 0 && existingMatchPerfScore !== 50))
    ) {
      categories.push('CUSTOM_LEGACY_SCORE_REVIEW');
    }
    if (Math.abs(recalculatedDiff(reconciled.gti, legacyBuggy.gti)) > 0.01) {
      categories.push('MATCH_ACTIVITY_BUG_0_NEQ_50');
    }
    if (
      (authoritativeWearable > 0 && Math.abs(existingWearableScore - authoritativeWearable) > 0.01) ||
      (authoritativeMatch > 0 && Math.abs(existingMatchPerfScore - authoritativeMatch) > 0.01) ||
      (hasAnyEvidence &&
        ((authoritativeWearable === 0 && existingWearableScore === 50) ||
          (authoritativeMatch === 0 && existingMatchPerfScore === 50)))
    ) {
      categories.push('COMPONENT_MIRROR_DRIFT');
    }
    if (
      Math.abs(existingGti - existingCurrentGti) > 0.01 ||
      (hasAnyEvidence && Math.abs(existingCurrentGti - reconciled.gti) > 0.01)
    ) {
      categories.push('COMPOSITE_GTI_DRIFT');
    }

    const beforeComposite = existingGti > 0 ? existingGti : existingCurrentGti;
    const afterComposite =
      categories.includes('CUSTOM_LEGACY_SCORE_REVIEW')
        ? beforeComposite
        : hasAnyEvidence || resetUnmeasuredBaseline || existingGti === 0 && existingCurrentGti === 0
          ? reconciled.gti
          : existingCurrentGti;

    return {
      profile: p,
      hasAnyEvidence,
      existingCurrentGti,
      existingGti,
      existingWearableScore,
      existingMatchPerfScore,
      authoritativeWearable,
      authoritativeMatch,
      reconciled,
      legacyBuggy,
      categories,
      beforeComposite,
      afterComposite,
    };
  });

  const beforeRanks = rankBySport(
    evaluations.map((e) => ({
      userId: e.profile.user_id,
      primarySport: e.profile.primary_sport,
      score: e.beforeComposite,
    })),
  );
  const afterRanks = rankBySport(
    evaluations.map((e) => ({
      userId: e.profile.user_id,
      primarySport: e.profile.primary_sport,
      score: e.afterComposite,
    })),
  );

  const affected: AffectedAthleteReport[] = [];
  let updatedCount = 0;
  let customLegacyReviewCount = 0;
  let eligibilityTransitions = 0;

  if (apply) {
    await db.query('BEGIN');
  }
  try {
    for (const entry of evaluations) {
      if (entry.categories.includes('CUSTOM_LEGACY_SCORE_REVIEW')) {
        customLegacyReviewCount++;
      }
      if (entry.categories.length === 0) continue;

      const userRegs = regByUser.get(entry.profile.user_id) ?? [];
      const affectedRegistrations = userRegs
        .map((reg) => {
          const minGti = Number(reg.min_gti);
          const maxGti = Number(reg.max_gti);
          const eligibleBefore = entry.existingCurrentGti >= minGti && entry.existingCurrentGti <= maxGti;
          const eligibleAfter = entry.afterComposite >= minGti && entry.afterComposite <= maxGti;
          if (eligibleBefore !== eligibleAfter) eligibilityTransitions++;
          return {
            registrationId: reg.registration_id,
            bracketId: reg.bracket_id,
            minGti,
            maxGti,
            eligibleBefore,
            eligibleAfter,
          };
        })
        .filter((reg) => reg.eligibleBefore !== reg.eligibleAfter);

      let updated = false;
      const canSafelyMutate = !entry.categories.includes('CUSTOM_LEGACY_SCORE_REVIEW');

      if (apply && canSafelyMutate) {
        const shouldResetComposite =
          entry.hasAnyEvidence ||
          (entry.categories.includes('UNMEASURED_SYNTHETIC_BASELINE') && resetUnmeasuredBaseline);

        const nextGti = shouldResetComposite ? entry.reconciled.gti : entry.existingGti;
        const nextCurrentGti = shouldResetComposite ? entry.reconciled.gti : entry.existingCurrentGti;
        const nextWearable = entry.authoritativeWearable;
        const nextMatch = entry.authoritativeMatch;

        await db.query(
          `
          UPDATE athlete_profiles
          SET gti = $2,
              current_gti = $3,
              wearable_score = $4,
              match_perf_score = $5
          WHERE id = $1
        `,
          [entry.profile.id, nextGti, nextCurrentGti, nextWearable, nextMatch],
        );

        if (shouldResetComposite && Math.abs(entry.existingCurrentGti - nextCurrentGti) > 0.01) {
          await db.query(
            `
            INSERT INTO gti_histories
              (id, athlete_id, biomechanical_score, wearable_score, match_score, composite_gti, calculation_factors)
            VALUES
              (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb)
          `,
            [
              entry.profile.id,
              entry.reconciled.biomechanicalScore,
              entry.authoritativeWearable,
              entry.authoritativeMatch,
              entry.reconciled.gti,
              JSON.stringify({
                w1: entry.reconciled.w1,
                w2: entry.reconciled.w2,
                w3: entry.reconciled.w3,
                calculationVersion: 'gti-v2-reconciled',
                triggerType: 'DATA_RECONCILIATION',
                previousCurrentGti: entry.existingCurrentGti,
                evidence: entry.reconciled.evidence,
                provisional: entry.reconciled.provisional,
              }),
            ],
          );
        }
        updated = true;
        updatedCount++;
      }

      affected.push({
        profileId: entry.profile.id,
        userId: entry.profile.user_id,
        primarySport: entry.profile.primary_sport,
        categories: entry.categories,
        existingCurrentGti: entry.existingCurrentGti,
        existingGti: entry.existingGti,
        recalculatedGti: entry.reconciled.gti,
        legacyBuggyGti: entry.legacyBuggy.gti,
        existingWearableScore: entry.existingWearableScore,
        authoritativeWearableScore: entry.authoritativeWearable,
        existingMatchPerfScore: entry.existingMatchPerfScore,
        authoritativeMatchPerfScore: entry.authoritativeMatch,
        sportRankBefore: beforeRanks.get(entry.profile.user_id) ?? null,
        sportRankAfter: afterRanks.get(entry.profile.user_id) ?? null,
        affectedRegistrations,
        updated,
      });
    }
    if (apply) {
      await db.query('COMMIT');
    }
  } catch (error) {
    if (apply) {
      await db.query('ROLLBACK');
    }
    throw error;
  }

  return {
    totalProfilesScanned: profiles.length,
    affectedCount: affected.length,
    updatedCount,
    customLegacyReviewCount,
    eligibilityTransitions,
    affected,
  };
}

function recalculatedDiff(a: number, b: number): number {
  return a - b;
}

async function runCli(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const resetUnmeasuredBaseline = process.argv.includes('--reset-unmeasured-baseline');
  const prisma = new PrismaClient();
  try {
    const adapter: ReconcileSqlDb = {
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const rows = (await prisma.$queryRawUnsafe<T[]>(sql, ...params)) as T[];
        return { rows };
      },
    };
    const summary = await reconcileGtiRecords(adapter, { apply, resetUnmeasuredBaseline });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', ...summary }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
