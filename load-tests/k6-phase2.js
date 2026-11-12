/**
 * KheLEO Phase 2 k6 Staging Load Test Suite
 *
 * Prerequisites:
 *   - Grafana k6 >= 0.50 installed against a staging Railway API deployment
 *   - Staging database seeded with representative athlete/tournament/outbox data
 *   - Set RATE_LIMIT_ENABLED=false or supply distributed/test accounts when benchmarking
 *     high single-IP auth bursts above 30 req/min
 *
 * Usage example:
 *   k6 run \
 *     -e BASE_URL=https://kheleo-staging.up.railway.app/api/v1 \
 *     -e ATHLETE_JWT="<jwt>" \
 *     -e ATHLETE_ID="<uuid>" \
 *     -e SCOUT_JWT="<scout_jwt>" \
 *     -e LOGIN_EMAIL="athlete@example.com" \
 *     -e LOGIN_PASSWORD="<password>" \
 *     -e TELEMETRY_ENABLED=true \
 *     -e DRILL_ENABLED=false \
 *     -e GTI_RECALC_ENABLED=false \
 *     load-tests/k6-phase2.js
 */

import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000/api/v1';
const ATHLETE_JWT = __ENV.ATHLETE_JWT || '';
const ATHLETE_ID = __ENV.ATHLETE_ID || '';
const SCOUT_JWT = __ENV.SCOUT_JWT || '';
const LOGIN_EMAIL = __ENV.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = __ENV.LOGIN_PASSWORD || '';
const DRILL_HMAC_SECRET = __ENV.DRILL_HMAC_SECRET || '';
const TELEMETRY_ENABLED = __ENV.TELEMETRY_ENABLED === 'true';
const DRILL_ENABLED = __ENV.DRILL_ENABLED === 'true';
const GTI_RECALC_ENABLED = __ENV.GTI_RECALC_ENABLED === 'true';

const passportDuration = new Trend('kheleo_passport_duration_ms', true);
const heatmapDuration = new Trend('kheleo_heatmap_duration_ms', true);
const leaderboardDuration = new Trend('kheleo_leaderboard_duration_ms', true);
const nearbyDuration = new Trend('kheleo_nearby_duration_ms', true);
const scoutFeedDuration = new Trend('kheleo_scout_feed_duration_ms', true);
const loginDuration = new Trend('kheleo_login_duration_ms', true);
const telemetryDuration = new Trend('kheleo_telemetry_duration_ms', true);
const drillDuration = new Trend('kheleo_drill_duration_ms', true);
const gtiRecalcDuration = new Trend('kheleo_gti_recalc_duration_ms', true);
const authRateLimited = new Rate('kheleo_auth_rate_limited');

export const options = {
  scenarios: {
    read_hotpath: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '20s', target: 25 },
        { duration: '40s', target: 100 },
        { duration: '40s', target: 150 },
        { duration: '20s', target: 0 },
      ],
      exec: 'readHotpathScenario',
      gracefulRampDown: '10s',
    },
    ...(LOGIN_EMAIL && LOGIN_PASSWORD
      ? {
          auth_login_burst: {
            executor: 'constant-arrival-rate',
            rate: 15,
            timeUnit: '1s',
            duration: '60s',
            preAllocatedVUs: 10,
            maxVUs: 40,
            exec: 'authLoginScenario',
          },
        }
      : {}),
    ...(ATHLETE_JWT && ATHLETE_ID && (TELEMETRY_ENABLED || DRILL_ENABLED || GTI_RECALC_ENABLED)
      ? {
          write_telemetry_and_drills: {
            executor: 'ramping-arrival-rate',
            startRate: 5,
            timeUnit: '1s',
            preAllocatedVUs: 15,
            maxVUs: 60,
            stages: [
              { duration: '20s', target: 15 },
              { duration: '40s', target: 40 },
              { duration: '20s', target: 5 },
            ],
            exec: 'writeWorkloadScenario',
          },
        }
      : {}),
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    kheleo_heatmap_duration_ms: ['p(95)<200'],
    kheleo_leaderboard_duration_ms: ['p(95)<250'],
    kheleo_nearby_duration_ms: ['p(95)<300'],
    kheleo_passport_duration_ms: ['p(95)<250'],
    http_req_duration: ['p(95)<500'],
  },
};

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function uniqueKey(prefix) {
  return `${prefix}-${__VU}-${__ITER}-${Date.now()}`;
}

export function readHotpathScenario() {
  group('Cached & Indexed Read Hotpaths', () => {
    const heatmapRes = http.get(`${BASE_URL}/heatmaps/regional`, {
      tags: { endpoint: 'heatmap_regional' },
    });
    heatmapDuration.add(heatmapRes.timings.duration);
    check(heatmapRes, {
      'heatmap status 200': (r) => r.status === 200,
    });

    const leaderboardRes = http.get(
      `${BASE_URL}/gti/leaderboards?scope=NATIONAL&sport=CRICKET&limit=20`,
      { tags: { endpoint: 'gti_leaderboards' } },
    );
    leaderboardDuration.add(leaderboardRes.timings.duration);
    check(leaderboardRes, {
      'leaderboard status 200': (r) => r.status === 200,
    });

    const nearbyRes = http.get(
      `${BASE_URL}/tournaments/nearby?lat=28.6139&lng=77.2090&radius_km=50&limit=20`,
      { tags: { endpoint: 'tournaments_nearby' } },
    );
    nearbyDuration.add(nearbyRes.timings.duration);
    check(nearbyRes, {
      'nearby status 200': (r) => r.status === 200,
    });

    if (ATHLETE_JWT && ATHLETE_ID) {
      const passportRes = http.get(`${BASE_URL}/passport/${ATHLETE_ID}`, {
        headers: { Authorization: `Bearer ${ATHLETE_JWT}` },
        tags: { endpoint: 'passport_read' },
      });
      passportDuration.add(passportRes.timings.duration);
      check(passportRes, {
        'passport status 200': (r) => r.status === 200,
      });
    }

    if (SCOUT_JWT) {
      const scoutRes = http.get(`${BASE_URL}/scouts/feed?sport=CRICKET&limit=20`, {
        headers: { Authorization: `Bearer ${SCOUT_JWT}` },
        tags: { endpoint: 'scouts_feed' },
      });
      scoutFeedDuration.add(scoutRes.timings.duration);
      check(scoutRes, {
        'scouts feed status 200': (r) => r.status === 200,
      });
    }
  });

  sleep(0.25);
}

export function authLoginScenario() {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      email: LOGIN_EMAIL,
      password: LOGIN_PASSWORD,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': uniqueKey('k6-login-key-0001'),
      },
      tags: { endpoint: 'auth_login' },
    },
  );
  loginDuration.add(res.timings.duration);
  authRateLimited.add(res.status === 429 ? 1 : 0);
  check(res, {
    'login 200 or expected 429 rate-limit': (r) => r.status === 200 || r.status === 429,
  });
}

export function writeWorkloadScenario() {
  if (TELEMETRY_ENABLED) {
    const telemetryPayload = {
      athlete_id: ATHLETE_ID,
      heart_rate: 142,
      spo2: 98,
      skin_temperature: 36.8,
      timestamp: Date.now(),
    };
    const res = http.post(
      `${BASE_URL}/safety/telemetry-webhook`,
      JSON.stringify(telemetryPayload),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ATHLETE_JWT}`,
          'Idempotency-Key': uniqueKey('k6-telemetry-key'),
        },
        tags: { endpoint: 'telemetry_webhook' },
      },
    );
    telemetryDuration.add(res.timings.duration);
    check(res, {
      'telemetry 200 or 429': (r) => r.status === 200 || r.status === 429,
    });
  }

  if (DRILL_ENABLED && DRILL_HMAC_SECRET) {
    const dto = {
      athlete_id: ATHLETE_ID,
      sport: 'CRICKET',
      drill_type: 'BOWLING',
      form_score: 84,
      frames_analyzed: 120,
      flaw_flags: [],
      joint_angles_summary: { elbow: 162 },
      timestamp: Date.now(),
    };
    const canonical = canonicalJson({
      athlete_id: dto.athlete_id,
      sport: dto.sport,
      drill_type: dto.drill_type,
      form_score: dto.form_score,
      frames_analyzed: dto.frames_analyzed,
      flaw_flags: dto.flaw_flags,
      joint_angles_summary: dto.joint_angles_summary,
      timestamp: dto.timestamp,
    });
    const sig = crypto.hmac('sha256', DRILL_HMAC_SECRET, canonical, 'hex');

    const res = http.post(`${BASE_URL}/drills/submit`, JSON.stringify(dto), {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ATHLETE_JWT}`,
        'Idempotency-Key': uniqueKey('k6-drill-submit'),
        'x-drill-signature': sig,
      },
      tags: { endpoint: 'drills_submit' },
    });
    drillDuration.add(res.timings.duration);
    check(res, {
      'drill submit 200 or 429': (r) => r.status === 200 || r.status === 429,
    });
  }

  if (GTI_RECALC_ENABLED) {
    const res = http.post(`${BASE_URL}/gti/recalculate/${ATHLETE_ID}`, '{}', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ATHLETE_JWT}`,
        'Idempotency-Key': uniqueKey('k6-gti-recalc-01'),
      },
      tags: { endpoint: 'gti_recalculate' },
    });
    gtiRecalcDuration.add(res.timings.duration);
    check(res, {
      'gti recalculate 200 or 429': (r) => r.status === 200 || r.status === 429,
    });
  }
}

