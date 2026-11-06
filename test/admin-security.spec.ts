import 'reflect-metadata';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { HealthService } from '../src/modules/health/health.service';
import { QueueProducerService } from '../src/infrastructure/queues/queue-producer.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import {
  createSecurityFixture,
  createSecurityApp,
  ATHLETE_ID,
  ORGANIZER_ID,
  SCOUT_ID,
  SUPER_ID,
} from './helpers/security-gti.fixture';
import { createAuthFixture, TEST_DOCUMENT } from './helpers/auth-passport.fixture';
import { GovIdType } from '@prisma/client';
function queue(name: string, paused = false, fail = false): Queue {
  return {
    name,
    getJobCounts: async () => {
      if (fail) throw new Error('private redis credentials');
      return { waiting: 2, active: 1, delayed: 0, failed: 3, completed: 10 };
    },
    isPaused: async () => paused,
  } as unknown as Queue;
}
describe('Prompt 4 administrative boundaries and security evidence', () => {
  it('measures PostgreSQL/PostGIS/Redis and queue probes without substituting success for outages', async () => {
    const prisma = {
      $queryRaw: async (parts: TemplateStringsArray) =>
        parts.join('').includes('PostGIS') ? [{ version: '3.5' }] : [{ ready: 1 }],
    } as unknown as PrismaService;
    const redis = { client: { ping: async () => 'PONG' } } as unknown as RedisService;
    const queues = new QueueProducerService(
      queue('gti-calculation'),
      queue('matchmaking', true),
      queue('scout-alerts', false, true),
    );
    const result = await new HealthService(prisma, redis, queues).diagnostics();
    assert.equal(typeof result.dbLatencyMs, 'number');
    assert.equal(typeof result.redisLatencyMs, 'number');
    assert.equal(result.postgisAvailable, true);
    assert.deepEqual(
      result.bullmqQueuesStatus.map((item) => item.status),
      ['ok', 'paused', 'unreachable'],
    );
    assert.equal(result.bullmqQueuesStatus[0]?.failed, 3);
    assert.equal(result.bullmqQueuesStatus[2]?.waiting, null);
    assert.equal(result.health.status, 'degraded');
    assert.equal(JSON.stringify(result).includes('private redis credentials'), false);
    const outage = await new HealthService(
      {
        $queryRaw: async () => {
          throw new Error('private database credentials');
        },
      } as unknown as PrismaService,
      {
        client: {
          ping: async () => {
            throw new Error('private redis credentials');
          },
        },
      } as unknown as RedisService,
    ).diagnostics();
    assert.equal(outage.dbLatencyMs, null);
    assert.equal(outage.redisLatencyMs, null);
    assert.equal(outage.postgisAvailable, false);
  });
  it('reports executive counters from verified evidence and immutable block/pause records', async () => {
    const f = await createSecurityFixture();
    for (const category of ['SAFETY_MATCH_PAUSE', 'SANDBAGGING_BLOCKED'] as const) {
      const id = randomUUID();
      f.state.tables.securityAuditLog.set(id, { id, category });
    }
    const id = randomUUID();
    f.state.tables.drillSubmission.set(id, {
      id,
      metadataVerified: true,
      signatureVersion: 'FULL_V2',
    });
    const metrics = await f.services.admin.dashboard();
    assert.equal(metrics.totalVerifiedAthletes, 2);
    assert.equal(metrics.activeTournaments, 1);
    assert.equal(metrics.totalOrganizersAndScouts, 2);
    assert.equal(metrics.totalVerifiedDrills, 1);
    assert.equal(metrics.totalSafetyMatchPauses, 1);
    assert.equal(metrics.totalSandbaggingBlocks, 1);
  });
  it('allows federation reads and tournament moderation while denying both user-governance aliases', async () => {
    const f = await createSecurityFixture();
    f.state.tables.user.get(ORGANIZER_ID)!.role = 'FEDERATION_ADMIN';
    f.state.tables.user.get(SCOUT_ID)!.isActive = false;
    const app = await createSecurityApp(f);
    const headers = { authorization: `Bearer ${f.token(ORGANIZER_ID)}` };
    try {
      for (const path of ['dashboard', 'users', 'tournaments', 'audit-logs'])
        assert.equal(
          (await app.inject({ method: 'GET', url: `/api/v1/admin/${path}`, headers })).statusCode,
          200,
        );
      const inactive = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/users?isActive=false',
        headers,
      });
      assert.equal(inactive.statusCode, 200, inactive.body);
      const rows = inactive.json<{ data: { id: string }[] }>().data;
      assert.deepEqual(
        rows.map((row) => row.id),
        [SCOUT_ID],
      );
      for (const suffix of ['status', 'governance']) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/users/${ATHLETE_ID}/${suffix}`,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { isActive: false },
        });
        assert.equal(response.statusCode, 403, response.body);
      }
      const unauth = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs' });
      assert.equal(unauth.statusCode, 401);
      const denied = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/dashboard',
        headers: { authorization: `Bearer ${f.token()}` },
      });
      assert.equal(denied.statusCode, 403);
    } finally {
      await app.close();
    }
  });
  it('approves bound staff identities, revokes all token families and audits the authoritative actor', async () => {
    const f = await createSecurityFixture();
    f.state.tables.identityVerification.get(ORGANIZER_ID)!.status = 'UNVERIFIED';
    for (const family of ['first', 'second']) {
      const id = randomUUID();
      f.state.tables.refreshToken.set(id, { id, userId: ORGANIZER_ID, family, revoked: false });
    }
    const app = await createSecurityApp(f);
    const headers = {
      authorization: `Bearer ${f.token(SUPER_ID)}`,
      'idempotency-key': randomUUID(),
    };
    try {
      const url = `/api/v1/admin/users/${ORGANIZER_ID}/governance`;
      const response = await app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { verificationStatus: 'VERIFIED', isActive: true, role: 'SCOUT' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(f.user(ORGANIZER_ID).role, 'SCOUT');
      assert.equal(f.user(ORGANIZER_ID).identityRecord?.status, 'VERIFIED');
      assert.ok([...f.state.tables.refreshToken.values()].every((entry) => entry.revoked === true));
      const event = [...f.state.tables.securityAuditLog.values()][0]!;
      assert.equal(event.category, 'ROLE_GOVERNANCE');
      assert.equal(event.actorUserId, SUPER_ID);
      assert.equal(event.targetId, ORGANIZER_ID);
      const replay = await app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { verificationStatus: 'VERIFIED', isActive: true, role: 'SCOUT' },
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(f.state.tables.securityAuditLog.size, 1);
      const forged = await app.inject({
        method: 'PATCH',
        url,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { isActive: false, actorUserId: ATHLETE_ID },
      });
      assert.equal(forged.statusCode, 400, forged.body);
    } finally {
      await app.close();
    }
  });
  it('moderates explicit statuses and feature/suspension fields and preserves terminal outcomes', async () => {
    const f = await createSecurityFixture();
    f.state.tables.user.get(ORGANIZER_ID)!.role = 'FEDERATION_ADMIN';
    const id = [...f.state.tables.tournament.keys()][0]!;
    const app = await createSecurityApp(f);
    try {
      for (const payload of [
        { featured: true },
        { suspended: true },
        { status: 'REGISTRATION_OPEN' },
        { status: 'REGISTRATION_CLOSED' },
        { status: 'IN_PROGRESS' },
        { status: 'CANCELLED' },
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/tournaments/${id}/moderation`,
          headers: {
            authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
            'idempotency-key': randomUUID(),
          },
          payload,
        });
        assert.equal(response.statusCode, 200, response.body);
      }
      assert.equal(f.state.tables.tournament.get(id)?.status, 'CANCELLED');
      assert.equal(f.state.tables.tournament.get(id)?.isFeatured, false);
      assert.equal(
        [...f.state.tables.securityAuditLog.values()].filter(
          (event) => event.category === 'TOURNAMENT_MODERATION',
        ).length,
        6,
      );
      const blocked = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/tournaments/${id}/moderation`,
        headers: {
          authorization: `Bearer ${f.token(ORGANIZER_ID)}`,
          'idempotency-key': randomUUID(),
        },
        payload: { status: 'REGISTRATION_OPEN' },
      });
      assert.equal(blocked.statusCode, 409, blocked.body);
    } finally {
      await app.close();
    }
  });
  it('persists tampered and stale drill rejections before returning 403 without retaining payloads or raw IPs', async () => {
    const f = await createSecurityFixture();
    const app = await createSecurityApp(f);
    const payload = {
      athlete_id: ATHLETE_ID,
      sport: 'CRICKET',
      drill_type: 'CRICKET_BOWLING',
      form_score: 90,
      frames_analyzed: 60,
      flaw_flags: [],
      joint_angles_summary: {},
      timestamp: Math.floor(Date.now() / 1000),
    };
    try {
      for (const timestamp of [payload.timestamp, payload.timestamp - 350]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/drills/submit',
          headers: {
            authorization: `Bearer ${f.token()}`,
            'idempotency-key': randomUUID(),
            'x-drill-signature': '0'.repeat(64),
            'x-drill-signed-fields': 'full-v2',
          },
          payload: { ...payload, timestamp },
        });
        assert.equal(response.statusCode, 403, response.body);
      }
      const events = [...f.state.tables.securityAuditLog.values()];
      assert.equal(events.length, 2);
      assert.ok(
        events.every(
          (event) => event.category === 'DRILL_HMAC_TAMPER' && event.actorUserId === ATHLETE_ID,
        ),
      );
      assert.deepEqual(
        events.map((event) => event.severity),
        ['CRITICAL', 'WARNING'],
      );
      assert.match(String(events[0]?.ipHash), /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(events).includes('127.0.0.1'), false);
      assert.equal(JSON.stringify(events).includes('joint_angles_summary'), false);
      const listing = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs?category=DRILL_HMAC_TAMPER&severity=WARNING&limit=1',
        headers: { authorization: `Bearer ${f.token(SUPER_ID)}` },
      });
      assert.equal(listing.statusCode, 200, listing.body);
      assert.equal(listing.json<{ data: unknown[] }>().data.length, 1);
    } finally {
      await app.close();
    }
  });
  it('records anonymous duplicate identity attempts without exposing identity hashes or blaming the existing owner', async () => {
    const f = createAuthFixture();
    await assert.rejects(
      f.auth.register({
        email: 'different@fixture.test',
        governmentId: { idType: GovIdType.AADHAAR, idNumber: TEST_DOCUMENT },
      }),
    );
    const event = f.state.auditLogs[0]!;
    assert.equal(event.category, 'GOV_ID_RESET');
    assert.equal(event.actorUserId, null);
    assert.equal(event.targetId, f.state.user.id);
    assert.equal(JSON.stringify(event).includes(TEST_DOCUMENT), false);
    assert.equal(JSON.stringify(event).includes('idHash'), false);
    const revoked = createAuthFixture();
    revoked.state.user.identityRecord!.status = 'REVOKED';
    await assert.rejects(
      revoked.auth.register({
        email: 'different@fixture.test',
        governmentId: { idType: GovIdType.AADHAAR, idNumber: TEST_DOCUMENT },
      }),
    );
    assert.equal(revoked.state.auditLogs[0]?.category, 'GOV_ID_RESET');
    assert.deepEqual(revoked.state.auditLogs[0]?.metadata, {
      outcome: 'BLOCKED_IDENTITY_OR_ACCOUNT_ACCESS',
    });
  });
});
