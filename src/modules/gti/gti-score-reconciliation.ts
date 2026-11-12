export interface ProfileScoreColumns {
  readonly gti?: number | null;
  readonly currentGti?: unknown;
  readonly biomechanicalScore?: number | null;
  readonly trainingConsistencyScore?: number | null;
  readonly wearableScore?: unknown;
  readonly matchPerformanceScore?: number | null;
  readonly matchPerfScore?: unknown;
}

export interface ReconciledDisplayScores {
  readonly currentGti: number;
  readonly biomechanicalScore: number;
  readonly wearableScore: number;
  readonly matchPerfScore: number;
}

export type GtiEvidenceStatus = {
  readonly biomechanical: 'VERIFIED' | 'NOT_AVAILABLE';
  readonly wearable: 'VERIFIED' | 'NOT_AVAILABLE';
  readonly matchPerformance: 'VERIFIED' | 'NOT_AVAILABLE';
};

export interface GtiBreakdownEvaluation {
  readonly gti: number;
  readonly w1: number;
  readonly w2: number;
  readonly w3: number;
  readonly biomechanicalScore: number;
  readonly wearableScore: number;
  readonly matchPerformanceScore: number;
  readonly hasDrillData: boolean;
  readonly hasWearableData: boolean;
  readonly hasVerifiedMatches: boolean;
  readonly hasRecordedMatchActivity: boolean;
  readonly evidence: GtiEvidenceStatus;
  readonly provisional: boolean;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolves authoritative display scores across legacy Decimal columns
 * (`currentGti`, `wearableScore`, `matchPerfScore`) and Float telemetry
 * columns (`gti`, `trainingConsistencyScore`, `matchPerformanceScore`).
 */
export function resolveProfileComponentScores(
  profile: ProfileScoreColumns,
  options?: { readonly preserveUnmeasuredOnboardingDefaults?: boolean },
): ReconciledDisplayScores {
  const preserveDefaults = options?.preserveUnmeasuredOnboardingDefaults ?? false;
  const biomechanicalScore = toFiniteNumber(profile.biomechanicalScore, 0);
  const measuredWearable = toFiniteNumber(profile.trainingConsistencyScore, 0);
  const legacyWearable = toFiniteNumber(profile.wearableScore, 0);
  const measuredMatch = toFiniteNumber(profile.matchPerformanceScore, 0);
  const legacyMatch = toFiniteNumber(profile.matchPerfScore, 0);
  const numericGti = toFiniteNumber(profile.gti, 0);
  const numericCurrentGti = toFiniteNumber(profile.currentGti, 0);

  const currentGti = numericGti > 0 ? numericGti : numericCurrentGti;
  const hasTelemetryOrRecalculation =
    numericGti > 0 ||
    biomechanicalScore > 0 ||
    measuredWearable > 0 ||
    measuredMatch > 0 ||
    numericCurrentGti === 0;

  const wearableScore =
    measuredWearable > 0
      ? measuredWearable
      : legacyWearable === 50 && (!preserveDefaults || hasTelemetryOrRecalculation)
        ? 0
        : legacyWearable;

  const matchPerfScore =
    measuredMatch > 0
      ? measuredMatch
      : legacyMatch === 50 && (!preserveDefaults || hasTelemetryOrRecalculation)
        ? 0
        : legacyMatch;

  return {
    currentGti,
    biomechanicalScore,
    wearableScore,
    matchPerfScore,
  };
}

export function computeCompositeGtiScore(
  biomechanicalScore: number,
  wearableScore: number,
  matchPerfScore: number,
  weights?: { readonly w1: number; readonly w2: number; readonly w3: number },
): number {
  const w1 = weights?.w1 ?? 0.35;
  const w2 = weights?.w2 ?? 0.25;
  const w3 = weights?.w3 ?? 0.4;
  return Number(
    Math.min(
      100,
      Math.max(0, biomechanicalScore * w1 + wearableScore * w2 + matchPerfScore * w3),
    ).toFixed(2),
  );
}

/**
 * Evaluates authoritative GTI v2 weights, composite score, evidence state,
 * and provisional status while preserving full/interim/partial rules.
 */
export function evaluateGtiBreakdown(input: {
  readonly biomechanicalScore: number;
  readonly wearableScore: number;
  readonly matchPerformanceScore: number;
  readonly drillsCount: number;
  readonly sessionsCount: number;
  readonly healthAlertsCount: number;
  readonly matchesCount: number;
  readonly totalPassportMatches: number;
  readonly legacyMatchActivityCheck?: boolean;
}): GtiBreakdownEvaluation {
  const {
    biomechanicalScore,
    wearableScore,
    matchPerformanceScore,
    drillsCount,
    sessionsCount,
    healthAlertsCount,
    matchesCount,
    totalPassportMatches,
    legacyMatchActivityCheck = false,
  } = input;

  const hasDrillData = drillsCount > 0 || biomechanicalScore > 0;
  const hasWearableData = sessionsCount > 0 || healthAlertsCount > 0 || wearableScore > 0;
  const hasVerifiedMatches = matchesCount > 0 || totalPassportMatches > 0;
  const hasRecordedMatchActivity = legacyMatchActivityCheck
    ? hasVerifiedMatches || matchPerformanceScore !== 50
    : hasVerifiedMatches || matchPerformanceScore > 0;

  const evidence: GtiEvidenceStatus = {
    biomechanical: drillsCount > 0 ? 'VERIFIED' : 'NOT_AVAILABLE',
    wearable: sessionsCount > 0 || healthAlertsCount > 0 ? 'VERIFIED' : 'NOT_AVAILABLE',
    matchPerformance: hasVerifiedMatches ? 'VERIFIED' : 'NOT_AVAILABLE',
  };

  let w1 = 0.35;
  let w2 = 0.25;
  let w3 = 0.4;

  if (hasDrillData && hasWearableData) {
    // Case 1: Standard Full-Telemetry Mode
    w1 = 0.35;
    w2 = 0.25;
    w3 = 0.4;
  } else if (!hasDrillData && !hasWearableData && hasRecordedMatchActivity) {
    // Case 2: Interim Tournament Competition Mode (Drills & Wearables under production)
    w1 = 0.0;
    w2 = 0.0;
    w3 = 1.0;
  } else if (hasDrillData || hasWearableData || hasRecordedMatchActivity) {
    // Case 3: Partial Telemetry Mode
    const rawW1 = hasDrillData ? 0.35 : 0;
    const rawW2 = hasWearableData ? 0.25 : 0;
    const rawW3 = hasRecordedMatchActivity ? 0.4 : 0;
    const activeWeightSum = rawW1 + rawW2 + rawW3;
    if (activeWeightSum > 0) {
      w1 = Number((rawW1 / activeWeightSum).toFixed(4));
      w2 = Number((rawW2 / activeWeightSum).toFixed(4));
      w3 = Number((rawW3 / activeWeightSum).toFixed(4));
    }
  }

  const gti = computeCompositeGtiScore(biomechanicalScore, wearableScore, matchPerformanceScore, {
    w1,
    w2,
    w3,
  });

  const activeEvidenceStatuses: Array<'VERIFIED' | 'NOT_AVAILABLE'> = [];
  if (hasDrillData) activeEvidenceStatuses.push(evidence.biomechanical);
  if (hasWearableData) activeEvidenceStatuses.push(evidence.wearable);
  if (hasRecordedMatchActivity) activeEvidenceStatuses.push(evidence.matchPerformance);

  const provisional =
    activeEvidenceStatuses.length === 0 ||
    activeEvidenceStatuses.some((status) => status !== 'VERIFIED');

  return {
    gti,
    w1,
    w2,
    w3,
    biomechanicalScore,
    wearableScore,
    matchPerformanceScore,
    hasDrillData,
    hasWearableData,
    hasVerifiedMatches,
    hasRecordedMatchActivity,
    evidence,
    provisional,
  };
}
