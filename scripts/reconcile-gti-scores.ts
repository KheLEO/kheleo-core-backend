import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { evaluateGtiBreakdown } from '../src/modules/gti/gti-score-reconciliation';

export type GtiDriftCategory =
  | 'UNMEASURED_SYNTHETIC_BASELINE'
  | 'MATCH_ACTIVITY_BUG_0_NEQ_50'
  | 'COMPONENT_MIRROR_DRIFT'
  | 'COMPOSITE_GTI_DRIFT'
  | 'CUSTOM_LEGACY_SCORE_REVIEW';

export interface ReconcileSqlDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction?<T>(operation: (tx: ReconcileSqlDb) => Promise<T>): Promise<T>;
}

export function prismaReconciliationDb(prisma: PrismaClient): ReconcileSqlDb {
  const adapter = (client: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>): ReconcileSqlDb => ({
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => ({
      rows: await client.$queryRawUnsafe<T[]>(sql, ...params),
    }),
  });
  return {
    ...adapter(prisma),
    transaction: (operation) =>
      prisma.$transaction((tx) => operation(adapter(tx)), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
  };
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
  readonly eligibleForUpdate: boolean;
  readonly proposedScores: {
    readonly gti: number;
    readonly currentGti: number;
    readonly wearableScore: number;
    readonly matchPerfScore: number;
  };
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
  watch_qualified: boolean;
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
  all_matches_count: number | string;
  all_passport_matches: number | string;
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
    list.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.userId.localeCompare(b.userId),
    );
    list.forEach((entry, idx) => ranks.set(entry.userId, idx + 1));
  }
  return ranks;
}

interface ReconciliationOptions {
  readonly apply?: boolean;
  readonly baselineOnly?: boolean;
  // Retained for CLI compatibility; it never resets healthy onboarding baselines.
  readonly resetUnmeasuredBaseline?: boolean;
}

export async function reconcileGtiRecords(
  db: ReconcileSqlDb,
  options: ReconciliationOptions = {},
): Promise<GtiReconciliationSummary> {
  if (db.transaction) return db.transaction((tx) => reconcileSnapshot(tx, options));
  if (options.apply)
    throw new Error('Applying GTI reconciliation requires a pinned interactive transaction');
  return reconcileSnapshot(db, options);
}

async function reconcileSnapshot(
  db: ReconcileSqlDb,
  options: ReconciliationOptions,
): Promise<GtiReconciliationSummary> {
  const apply = options.apply ?? false;

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
      ap.watch_qualified,
      (SELECT COUNT(*)::int FROM drill_submissions ds WHERE ds.athlete_id = ap.user_id) AS drills_count,
      (SELECT COUNT(*)::int FROM wearable_sessions ws WHERE ws.athlete_id = ap.user_id AND ws.readings_count>0) AS sessions_count,
      (SELECT COUNT(*)::int FROM health_alerts ha WHERE ha.athlete_id = ap.user_id) AS alerts_count,
      (SELECT COUNT(*)::int FROM verified_match_results vmr WHERE ap.user_id = ANY(vmr.participant_athlete_ids)) AS all_matches_count,
      COALESCE((SELECT SUM(spr.total_matches)::int FROM sport_passport_records spr WHERE spr.athlete_id = ap.id), 0) AS all_passport_matches,
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
          AND (ap.primary_sport IS NULL OR spr.sport = ap.primary_sport)
      ), 0) AS total_passport_matches
    FROM athlete_score_policy ap
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
      watchQualified: p.watch_qualified,
      wearableScore: authoritativeWearable,
      matchPerformanceScore: authoritativeMatch,
      drillsCount: Number(p.drills_count),
      sessionsCount: Number(p.sessions_count),
      healthAlertsCount: Number(p.alerts_count),
      matchesCount: Number(p.matches_count),
      totalPassportMatches: Number(p.total_passport_matches),
      onboardingGti: existingCurrentGti > 0 ? existingCurrentGti : 30,
    };

    const reconciled = evaluateGtiBreakdown({ ...commonInput, legacyMatchActivityCheck: false });
    const legacyBuggy = evaluateGtiBreakdown({ ...commonInput, legacyMatchActivityCheck: true });
    const hasWearableEvidence = commonInput.sessionsCount > 0 || authoritativeWearable > 0;
    const hasMatchEvidence = reconciled.hasRecordedMatchActivity;

    const categories: GtiDriftCategory[] = [];
    const hasAnyEvidence =
      commonInput.drillsCount > 0 ||
      commonInput.sessionsCount > 0 ||
      Number(p.all_matches_count) > 0 ||
      Number(p.all_passport_matches) > 0 ||
      biomechanical > 0 ||
      authoritativeWearable > 0 ||
      authoritativeMatch > 0;

    const wipedOnboarding =
      !hasAnyEvidence &&
      existingCurrentGti <= 0 &&
      existingGti <= 0 &&
      biomechanical === 0 &&
      authoritativeWearable === 0 &&
      authoritativeMatch === 0 &&
      [0, 50].includes(existingWearableScore) &&
      [0, 50].includes(existingMatchPerfScore);
    if (wipedOnboarding) {
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
      (hasWearableEvidence && Math.abs(existingWearableScore - authoritativeWearable) > 0.01) ||
      (hasMatchEvidence && Math.abs(existingMatchPerfScore - authoritativeMatch) > 0.01)
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
    const canUpdate =
      wipedOnboarding ||
      (!options.baselineOnly &&
        hasAnyEvidence &&
        !categories.includes('CUSTOM_LEGACY_SCORE_REVIEW'));
    const afterComposite = canUpdate ? (wipedOnboarding ? 30 : reconciled.gti) : existingCurrentGti;
    const proposedScores = canUpdate
      ? {
          gti: afterComposite,
          currentGti: afterComposite,
          wearableScore: wipedOnboarding
            ? 50
            : hasWearableEvidence
              ? authoritativeWearable
              : existingWearableScore,
          matchPerfScore: wipedOnboarding
            ? 50
            : hasMatchEvidence
              ? authoritativeMatch
              : existingMatchPerfScore,
        }
      : {
          gti: existingGti,
          currentGti: existingCurrentGti,
          wearableScore: existingWearableScore,
          matchPerfScore: existingMatchPerfScore,
        };
    const eligibleForUpdate =
      canUpdate &&
      (Math.abs(proposedScores.gti - existingGti) > 0.01 ||
        Math.abs(proposedScores.currentGti - existingCurrentGti) > 0.01 ||
        Math.abs(proposedScores.wearableScore - existingWearableScore) > 0.01 ||
        Math.abs(proposedScores.matchPerfScore - existingMatchPerfScore) > 0.01);

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
      eligibleForUpdate,
      proposedScores,
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
        const eligibleBefore =
          entry.existingCurrentGti >= minGti && entry.existingCurrentGti <= maxGti;
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
    if (apply && entry.eligibleForUpdate) {
      const {
        gti: nextGti,
        currentGti: nextCurrentGti,
        wearableScore: nextWearable,
        matchPerfScore: nextMatch,
      } = entry.proposedScores;

      await db.query(
        `
          UPDATE athlete_profiles
          SET gti = $2,
              current_gti = $3,
              wearable_score = $4,
              match_perf_score = $5,
              updated_at = now()
          WHERE id = $1
          RETURNING id
        `,
        [entry.profile.id, nextGti, nextCurrentGti, nextWearable, nextMatch],
      );

      if (Math.abs(entry.existingCurrentGti - nextCurrentGti) > 0.01) {
        await db.query(
          `
            INSERT INTO gti_histories
              (id, athlete_id, biomechanical_score, wearable_score, match_score, composite_gti, calculation_factors)
            VALUES
              (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb)
            RETURNING id
          `,
          [
            entry.profile.id,
            entry.reconciled.biomechanicalScore,
            nextWearable,
            nextMatch,
            nextCurrentGti,
            JSON.stringify({
              w1: entry.reconciled.w1,
              w2: entry.reconciled.w2,
              w3: entry.reconciled.w3,
              calculationVersion: 'gti-v2-reconciled',
              triggerType: 'DATA_RECONCILIATION',
              previousCurrentGti: entry.existingCurrentGti,
              evidence: entry.reconciled.evidence,
              provisional: entry.reconciled.provisional,
              ...(entry.reconciled.isUnmeasuredOnboarding
                ? { calculationMode: 'ONBOARDING_BASELINE', baselineGti: nextCurrentGti }
                : {}),
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
      eligibleForUpdate: entry.eligibleForUpdate,
      proposedScores: entry.proposedScores,
    });
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
    const adapter = prismaReconciliationDb(prisma);
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
