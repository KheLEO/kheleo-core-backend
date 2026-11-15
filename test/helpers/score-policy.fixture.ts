import { evaluateGtiBreakdown } from '../../src/modules/gti/gti-score-reconciliation';
import { WATCH_TELEMETRY_WINDOW_MS } from '../../src/modules/gti/biomechanical-policy';

type Row = Record<string, unknown>;
export function scorePolicyFixture(
  profile: Row,
  drills: Row[],
  sessions: Row[],
  matches: Row[],
  sports: Row[],
) {
  const watchQualified = sessions.some(
    (session) =>
      session.hardwareObservedAt != null &&
      new Date(session.hardwareObservedAt as string).getTime() >=
        Date.now() - WATCH_TELEMETRY_WINDOW_MS &&
      new Date(session.hardwareObservedAt as string).getTime() <= Date.now(),
  );
  const result = evaluateGtiBreakdown({
    biomechanicalScore: Number(profile.biomechanicalScore ?? 0),
    wearableScore: Number(profile.trainingConsistencyScore ?? 0),
    matchPerformanceScore: Number(profile.matchPerformanceScore ?? 0),
    drillsCount: drills.length,
    sessionsCount: sessions.filter((session) => Number(session.readingsCount) > 0).length,
    healthAlertsCount: 0,
    matchesCount: matches.length,
    totalPassportMatches: sports.reduce((sum, row) => sum + Number(row.totalMatches ?? 0), 0),
    onboardingGti: Number(profile.currentGti) > 0 ? Number(profile.currentGti) : 30,
    watchQualified,
  });
  return {
    watchExpiresAt: watchQualified
      ? Math.max(
          ...sessions
            .map((session) => new Date(session.hardwareObservedAt as string).getTime())
            .filter(Number.isFinite),
        ) + WATCH_TELEMETRY_WINDOW_MS
      : null,
    userId: profile.userId,
    biomechanicalScore: result.biomechanicalScore,
    watchQualified,
    calculationMode: result.isUnmeasuredOnboarding ? 'ONBOARDING_BASELINE' : 'WEIGHTED',
    gti:
      result.isUnmeasuredOnboarding || Number(profile.biomechanicalScore) > 35
        ? result.gti
        : Number(profile.gti) || Number(profile.currentGti),
  };
}
