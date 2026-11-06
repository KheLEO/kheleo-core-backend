import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  ExecutionContext,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { GovIdType, Prisma } from '@prisma/client';
import { verifyContactProof } from '../src/modules/auth/contact-proof';
import { validateEnvironment } from '../src/config/validate-environment';
import { redisOptions } from '../src/infrastructure/cache/redis-options';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import {
  QueueProducerService,
  GtiRecalculationPayload,
} from '../src/infrastructure/queues/queue-producer.service';
import { WsEventGateway } from '../src/infrastructure/realtime/ws-event.gateway';
import { WsAuthGuard } from '../src/infrastructure/realtime/ws-auth.guard';
import { MatchmakingGateway } from '../src/modules/matchmaking/matchmaking.gateway';
import { LeaderboardsService } from '../src/modules/leaderboards/leaderboards.service';
import { createAuthFixture, TEST_DOCUMENT } from './helpers/auth-passport.fixture';
import { createSecurityFixture, ATHLETE_ID, DRILL_SECRET } from './helpers/security-gti.fixture';
import {
  DrillSignatureGuard,
  fullDrillPayload,
} from '../src/modules/drills/guards/drill-signature.guard';
import { createHmac } from 'node:crypto';

const subject = 'abababab-abab-4bab-8bab-abababababab';
function configuration(values: Readonly<Record<string, unknown>>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}
const production = configuration({
  'app.nodeEnv': 'production',
  'auth.supabaseUrl': 'https://identity.example.test',
  'auth.supabasePublishableKey': 'synthetic-public-key',
});
const confirmed = {
  id: subject,
  email: 'athlete@fixture.test',
  email_confirmed_at: new Date().toISOString(),
};
const responder =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Release contact authority and operational safeguards', () => {
  it('rejects production contact/document knowledge without provider proof before account lookup', async () => {
    await assert.rejects(
      verifyContactProof(production, { email: confirmed.email }),
      UnauthorizedException,
    );
    const f = createAuthFixture({ config: { 'app.nodeEnv': 'production' } });
    await assert.rejects(
      f.auth.login({
        email: confirmed.email,
        governmentId: { idType: GovIdType.AADHAAR, idNumber: TEST_DOCUMENT },
      }),
      UnauthorizedException,
    );
  });
  it('verifies confirmed contact at the provider and rejects mismatches, unconfirmed contacts, and provider failures', async () => {
    const input = { email: confirmed.email, identityAccessToken: 'synthetic-access-token' };
    assert.equal(
      (await verifyContactProof(production, input, responder(confirmed)))?.subject,
      subject,
    );
    await assert.rejects(
      verifyContactProof(
        production,
        { ...input, email: 'other@fixture.test' },
        responder(confirmed),
      ),
      UnauthorizedException,
    );
    await assert.rejects(
      verifyContactProof(production, input, responder({ ...confirmed, email_confirmed_at: null })),
      UnauthorizedException,
    );
    await assert.rejects(
      verifyContactProof(production, input, responder({}, 401)),
      UnauthorizedException,
    );
    await assert.rejects(
      verifyContactProof(production, input, responder({}, 503)),
      ServiceUnavailableException,
    );
  });
  it('creates a provider-bound production account with pending government identity instead of self-verification', async () => {
    const f = createAuthFixture({
      config: {
        'app.nodeEnv': 'production',
        'auth.supabaseUrl': 'https://identity.example.test',
        'auth.supabasePublishableKey': 'synthetic-key',
      },
    });
    const saved = globalThis.fetch;
    globalThis.fetch = responder({ ...confirmed, email: 'new@fixture.test' });
    try {
      const result = await f.auth.register({
        email: 'new@fixture.test',
        identityAccessToken: 'synthetic',
        governmentId: { idType: GovIdType.AADHAAR, idNumber: '123498761234' },
      });
      assert.equal(result.user.id, subject);
      assert.equal(result.user.isVerified, false);
      assert.equal(f.state.user.identityRecord?.status, 'UNVERIFIED');
    } finally {
      globalThis.fetch = saved;
    }
  });
  it('prevents self-recovery of an administratively suspended account', async () => {
    const f = createAuthFixture();
    f.state.user.isRecoveryBlocked = true;
    await assert.rejects(
      f.auth.register({
        email: f.state.user.email!,
        governmentId: { idType: GovIdType.AADHAAR, idNumber: TEST_DOCUMENT },
      }),
      /administrator reactivation/,
    );
  });
  it('requires full drill signing in production while accepting full payloads', async () => {
    const f = await createSecurityFixture();
    const guard = new DrillSignatureGuard(
      configuration({ 'app.nodeEnv': 'production', 'auth.drillHmacSecret': DRILL_SECRET }),
      f.prisma,
    );
    const dto = {
      athlete_id: ATHLETE_ID,
      sport: 'CRICKET' as const,
      drill_type: 'BOWLING',
      form_score: 90,
      frames_analyzed: 300,
      flaw_flags: [],
      timestamp: Math.floor(Date.now() / 1000),
    };
    const sign = (text: string): string =>
      createHmac('sha256', DRILL_SECRET).update(text).digest('hex');
    const ctx = (hash: string): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'x-drill-signature': hash },
            body: dto,
            user: { sub: ATHLETE_ID },
          }),
        }),
      }) as unknown as ExecutionContext;
    await assert.rejects(() =>
      guard.canActivate(ctx(sign(`${ATHLETE_ID}:BOWLING:90:${dto.timestamp}`))),
    );
    assert.equal(await guard.canActivate(ctx(sign(fullDrillPayload(ATHLETE_ID, dto)))), true);
    void f;
  });
  it('parses Redis TLS, ACL and database settings and bounds command connection behavior', () => {
    const opts = redisOptions(
      configuration({
        'redis.url': 'rediss://service:synthetic-password@redis.example.test:6380/2',
      }),
    );
    assert.equal(opts.host, 'redis.example.test');
    assert.equal(opts.username, 'service');
    assert.equal(opts.db, 2);
    assert.deepEqual(opts.tls, { rejectUnauthorized: true });
    assert.equal(opts.connectTimeout, 5000);
    assert.equal(opts.enableOfflineQueue, false);
    assert.equal(redisOptions(configuration({}), true).maxRetriesPerRequest, null);
  });
  it('fails production startup on placeholder secrets and permits local test configuration', () => {
    assert.throws(
      () => validateEnvironment({ NODE_ENV: 'production', IDENTITY_PEPPER: 'change_me' }),
      /random bytes/,
    );
    assert.deepEqual(validateEnvironment({ NODE_ENV: 'test' }), { NODE_ENV: 'test' });
  });
});

describe('Durable outbox recovery on migrated Postgres', () => {
  const database = new PGlite({ extensions: { postgis } });
  const athlete = randomUUID();
  before(async () => {
    const root = resolve(__dirname, '../prisma/migrations');
    for (const directory of readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name)))
      await database.exec(readFileSync(resolve(root, directory.name, 'migration.sql'), 'utf8'));
    await database.query('INSERT INTO users(id,updated_at) VALUES($1,now())', [athlete]);
    await database.query(
      "INSERT INTO athlete_profiles(id,user_id,district,state,primary_sport,updated_at) VALUES($1,$2,'Pune','Maharashtra','CRICKET',now())",
      [randomUUID(), athlete],
    );
  });
  after(async () => {
    await database.close();
  });
  const addDrill = async (id: string): Promise<void> => {
    await database.query(
      "INSERT INTO drill_submissions(id,athlete_id,sport,drill_type,form_score,frames_analyzed,flaw_flags,joint_angles_summary,signature_hash) VALUES($1,$2,'CRICKET','BOWLING',90,300,'[]','{}',$3)",
      [id, athlete, id.replaceAll('-', '').padEnd(64, 'a')],
    );
  };
  function adapter(): PrismaService {
    return {
      $queryRaw: async (sql: Prisma.Sql) => (await database.query(sql.text, sql.values)).rows,
      outboxEvent: {
        updateMany: async (args: Prisma.OutboxEventUpdateManyArgs) => {
          const data = args.data;
          const where = args.where!;
          const result = await database.query(
            data.deliveredAt
              ? 'UPDATE outbox_events SET delivered_at=now(),locked_by=NULL,locked_until=NULL,last_error=NULL,attempts=attempts+1 WHERE id=$1 AND locked_by=$2'
              : 'UPDATE outbox_events SET locked_by=NULL,locked_until=NULL,last_error=$3,available_at=$4,attempts=attempts+1 WHERE id=$1 AND locked_by=$2',
            data.deliveredAt
              ? [where.id, where.lockedBy]
              : [where.id, where.lockedBy, data.lastError, data.availableAt],
          );
          return { count: result.affectedRows ?? 0 };
        },
      },
    } as unknown as PrismaService;
  }
  function dispatcher(
    send: (payload: GtiRecalculationPayload, id?: string) => Promise<string>,
  ): OutboxDispatcher {
    return new OutboxDispatcher(
      adapter(),
      { enqueueGtiRecalculation: send } as unknown as QueueProducerService,
      {} as WsEventGateway,
      {} as MatchmakingGateway,
      { syncAthlete: async () => undefined } as unknown as LeaderboardsService,
      {} as WsAuthGuard,
    );
  }
  it('rolls back delivery intent with the source write', async () => {
    const id = randomUUID();
    await database.exec('BEGIN');
    await addDrill(id);
    await database.exec('ROLLBACK');
    assert.equal(
      (
        await database.query("SELECT id FROM outbox_events WHERE payload->>'deliveryId'=$1", [
          `drill-${id}`,
        ])
      ).rows.length,
      0,
    );
  });
  it('retains failed publication across process restart, then recovers the original intent with a stable job ID', async () => {
    await database.exec('DELETE FROM outbox_events');
    const id = randomUUID();
    await addDrill(id);
    await dispatcher(async () => {
      throw new Error('Synthetic Redis outage');
    }).dispatchOnce();
    const failed = (
      await database.query<{ attempts: number; delivered_at: Date | null }>(
        'SELECT attempts,delivered_at FROM outbox_events',
      )
    ).rows[0]!;
    assert.equal(failed.attempts, 1);
    assert.equal(failed.delivered_at, null);
    await database.exec('UPDATE outbox_events SET available_at=now()');
    const sent: string[] = [];
    await dispatcher(async (payload, deliveryId) => {
      assert.equal(payload.athleteId, athlete);
      sent.push(deliveryId!);
      return deliveryId!;
    }).dispatchOnce();
    assert.deepEqual(sent, [`drill-${id}`]);
    assert.equal(
      (await database.query('SELECT id FROM outbox_events WHERE delivered_at IS NULL')).rows.length,
      0,
    );
  });
  it('leases pending deliveries so concurrent dispatchers cannot claim the same event', async () => {
    await database.exec('DELETE FROM outbox_events');
    await addDrill(randomUUID());
    let deliveries = 0;
    await Promise.all([
      dispatcher(async () => {
        deliveries++;
        return 'job';
      }).dispatchOnce(),
      dispatcher(async () => {
        deliveries++;
        return 'job';
      }).dispatchOnce(),
    ]);
    assert.equal(deliveries, 1);
  });
  it('retains permanent identity bindings on attempted physical account deletion', async () => {
    await database.query(
      "INSERT INTO identity_verifications(id,user_id,id_hash,id_type) VALUES($1,$2,$3,'AADHAAR')",
      [randomUUID(), athlete, 'f'.repeat(64)],
    );
    await assert.rejects(
      database.query('DELETE FROM users WHERE id=$1', [athlete]),
      /foreign key constraint/,
    );
    assert.equal(
      (await database.query('SELECT id FROM identity_verifications WHERE user_id=$1', [athlete]))
        .rows.length,
      1,
    );
  });
  it('enables RLS on application tables while preserving append-only audit snapshots', async () => {
    const rows = await database.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE relname IN ('users','outbox_events','health_alerts')",
    );
    assert.ok(rows.rows.every((row) => row.relrowsecurity));
    await assert.rejects(
      database.exec("UPDATE security_audit_logs SET action='MODIFIED'"),
      /append-only/,
    );
  });
});
