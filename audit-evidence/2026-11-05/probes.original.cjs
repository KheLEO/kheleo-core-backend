const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '../..');
const fromRepo = createRequire(path.join(repo, 'package.json'));
fromRepo('reflect-metadata');
const { firstValueFrom, of } = fromRepo('rxjs');
const { Module, ValidationPipe, VersioningType } = fromRepo('@nestjs/common');
const { NestFactory } = fromRepo('@nestjs/core');
const { FastifyAdapter } = fromRepo('@nestjs/platform-fastify');
const { ConfigService } = fromRepo('@nestjs/config');
const { SwaggerModule, DocumentBuilder } = fromRepo('@nestjs/swagger');
const compiled = (file) => fromRepo(path.join(repo, 'dist/src', file));
const { IdempotencyInterceptor } = compiled('common/interceptors/idempotency.interceptor.js');
const { DrillSignatureGuard } = compiled('modules/drills/guards/drill-signature.guard.js');
const { WsAuthGuard } = compiled('infrastructure/realtime/ws-auth.guard.js');
const { WsEventGateway } = compiled('infrastructure/realtime/ws-event.gateway.js');
const { LoginDto } = compiled('modules/auth/dto/login.dto.js');
const { AuthService } = compiled('modules/auth/auth.service.js');
const { MatchmakingService } = compiled('modules/matchmaking/matchmaking.service.js');
const { RedisService } = compiled('infrastructure/cache/redis.service.js');
const { RolesGuard } = compiled('common/guards/roles.guard.js');
const { JwtAuthGuard } = compiled('common/guards/jwt-auth.guard.js');
const { HmacTamperGuard } = compiled('common/guards/hmac-tamper.guard.js');
const results = [];
const config = { get: (key, fallback) => ({
  'auth.identityPepper': 'synthetic-audit-pepper',
  'auth.drillHmacSecret': 'synthetic-audit-drill-secret',
  'auth.telemetryHmacSecret': 'synthetic-audit-telemetry-secret',
  'auth.jwtPublicKeyPath': '/tmp/kheleo-audit-nonexistent-public.pem',
  'auth.jwtPrivateKeyPath': '/tmp/kheleo-audit-nonexistent-private.pem',
  'app.nodeEnv': 'development',
}[key] ?? fallback) };
const memory = new Map();
const redis = {
  get: async (key) => memory.get(key) ?? null,
  set: async (key, value) => { memory.set(key, value); },
  setnx: async (key, value) => {
    if (memory.has(key)) return false;
    memory.set(key, value);
    return true;
  },
  del: async (key) => { memory.delete(key); },
};
const context = (request) => {
  const reply = { statusCode: 201, header: () => reply, status: (code) => {
    reply.statusCode = code;
    return reply;
  } };
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }) };
};

async function main() {
  const interceptor = new IdempotencyInterceptor(redis);
  const request = { method: 'POST', url: '/api/v1/tournaments/t/brackets/b/free-agents/join',
    headers: { 'idempotency-key': 'same-synthetic-key-123456' }, body: { primary_role: 'BATSMAN' } };
  const first = await firstValueFrom(await interceptor.intercept(
    context({ ...request, user: { sub: 'athlete-A' } }),
    { handle: () => of({ owner: 'athlete-A', registrationId: 'private-registration-A' }) },
  ));
  const second = await firstValueFrom(await interceptor.intercept(
    context({ ...request, user: { sub: 'athlete-B' } }),
    { handle: () => { throw new Error('Second handler should have run for athlete B'); } },
  ));
  assert.deepEqual(second, first);
  results.push({ probe: 'cross_user_idempotency', finding: 'Second user receives first user cached response; second handler skipped', returnedOwner: second.owner });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', 'synthetic-audit-drill-secret')
    .update(`athlete-A:BOWLING:90:${timestamp}`).digest('hex');
  const tampered = { athlete_id: 'athlete-A', drill_type: 'BOWLING', form_score: 90,
    timestamp, sport: 'FOOTBALL', frames_analyzed: 999999, flaw_flags: ['changed'] };
  const accepted = new DrillSignatureGuard(config).canActivate(context({
    headers: { 'x-drill-signature': signature }, body: tampered, user: { sub: 'athlete-A' },
  }));
  assert.equal(accepted, true);
  results.push({ probe: 'unsigned_drill_metadata', finding: 'HMAC accepts changed sport, frames_analyzed and flaw_flags', accepted });

  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
    transformOptions: { enableImplicitConversion: true } });
  const missingProof = await pipe.transform({ email: 'synthetic@example.test' },
    { type: 'body', metatype: LoginDto });
  let loginError;
  try {
    await new AuthService({ user: { findFirst: async () => ({ id: 'athlete-A', isActive: true,
      identityRecord: { idHash: '0'.repeat(64), status: 'VERIFIED' } }) } }, {}, config).login(missingProof);
  } catch (error) { loginError = error; }
  assert.ok(loginError instanceof TypeError);
  results.push({ probe: 'missing_login_government_id', finding: 'Global ValidationPipe accepts missing nested governmentId; service throws TypeError', error: loginError.message });

  const service = new MatchmakingService({}, {}, {});
  const greedyResult = service.matchCandidatesToSlots([
    { primaryRole: 'BATSMAN', secondaryRole: 'BOWLER' },
    { primaryRole: 'BATSMAN', secondaryRole: null },
    { primaryRole: 'ALL_ROUNDER', secondaryRole: null },
    { primaryRole: 'WICKETKEEPER', secondaryRole: null },
  ], service.getSlotRequirements('CRICKET', 4));
  assert.equal(greedyResult, null);
  results.push({ probe: 'greedy_role_assignment', finding: 'Rejects feasible 4-player roster: specialist could fill batsman and dual-role player bowler', result: greedyResult });

  const domains = ['auth', 'users', 'passport', 'tournaments', 'brackets', 'matchmaking', 'drills', 'safety', 'gti', 'scouts', 'heatmaps'];
  const classes = domains.map((domain) => {
    const name = domain[0].toUpperCase() + domain.slice(1);
    return {
      controller: compiled(`modules/${domain}/${domain}.controller.js`)[`${name}Controller`],
      service: compiled(`modules/${domain}/${domain}.service.js`)[`${name}Service`],
    };
  });
  class AuditModule {}
  Module({ controllers: classes.map(({ controller }) => controller), providers: [
    ...classes.map(({ service }) => ({ provide: service, useValue: {} })),
    { provide: ConfigService, useValue: config }, { provide: RedisService, useValue: redis },
    IdempotencyInterceptor, JwtAuthGuard, RolesGuard, HmacTamperGuard, DrillSignatureGuard,
    WsEventGateway, WsAuthGuard,
  ] })(AuditModule);
  const app = await NestFactory.create(AuditModule, new FastifyAdapter(), { logger: false });
  try {
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    const document = SwaggerModule.createDocument(app,
      new DocumentBuilder().setTitle('Audit of actual controller metadata').setVersion('1').build());
    fs.writeFileSync(path.join(__dirname, 'openapi.json'), JSON.stringify(document, null, 2));
    results.push({ probe: 'controller_inventory', httpOperations: Object.values(document.paths)
      .reduce((count, operations) => count + Object.keys(operations).filter((key) => ['get','post','patch','delete','put'].includes(key)).length, 0),
      paths: Object.keys(document.paths).length });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const event = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`);
      const timer = setTimeout(() => { socket.close(); reject(new Error('Socket probe timed out')); }, 4000);
      socket.addEventListener('message', ({ data }) => {
        const packet = String(data);
        if (packet.startsWith('0')) socket.send('40/ws/events,');
        if (packet === '2') socket.send('3');
        if (packet.startsWith('40/ws/events,')) {
          app.get(WsEventGateway).broadcastAutonomousMatchPause({ event: 'MATCH_PAUSE_ALERT', severity: 'CRITICAL',
            athlete_id: 'synthetic-athlete', athlete_name: 'Synthetic Athlete',
            vitals: { heart_rate: 196, spo2: 99, skin_temperature: 37 }, directive: 'synthetic-audit-event' });
        }
        if (packet.startsWith('42/ws/events,') && packet.includes('MATCH_PAUSE_ALERT')) {
          clearTimeout(timer); socket.close(); resolve(packet);
        }
      });
      socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); });
    });
    assert.ok(event.includes('synthetic-athlete'));
    results.push({ probe: 'anonymous_safety_broadcast', finding: 'Anonymous Socket.IO connection receives MATCH_PAUSE_ALERT with athlete name and vitals', receivedWithoutToken: true });
  } finally { await app.close(); }
  fs.writeFileSync(path.join(__dirname, 'probe-results.json'), JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}
main().catch((error) => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; });
