const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '../..');
const requireRepo = createRequire(path.join(repo, 'package.json'));
requireRepo('reflect-metadata');
const { firstValueFrom, of } = requireRepo('rxjs');
const { Module, ValidationPipe, VersioningType, BadRequestException, ForbiddenException } =
  requireRepo('@nestjs/common');
const { NestFactory } = requireRepo('@nestjs/core');
const { FastifyAdapter } = requireRepo('@nestjs/platform-fastify');
const { ConfigService } = requireRepo('@nestjs/config');
const { SwaggerModule, DocumentBuilder } = requireRepo('@nestjs/swagger');
const { Server } = requireRepo('socket.io');
const { io } = requireRepo('socket.io-client');
const jwt = requireRepo('jsonwebtoken');
const compiled = (file) => requireRepo(path.join(repo, 'dist', file));
const { IdempotencyInterceptor } = compiled('common/interceptors/idempotency.interceptor.js');
const { DrillSignatureGuard, fullDrillPayload } = compiled(
  'modules/drills/guards/drill-signature.guard.js',
);
const { WsAuthGuard } = compiled('infrastructure/realtime/ws-auth.guard.js');
const { WsEventGateway } = compiled('infrastructure/realtime/ws-event.gateway.js');
const { RoomAccessService } = compiled('infrastructure/realtime/room-access.service.js');
const { JwtStrategy } = compiled('modules/auth/strategies/jwt.strategy.js');
const { LoginDto } = compiled('modules/auth/dto/login.dto.js');
const { MatchmakingService } = compiled('modules/matchmaking/matchmaking.service.js');
const { RedisService } = compiled('infrastructure/cache/redis.service.js');
const { PrismaService } = compiled('infrastructure/database/prisma.service.js');
const { RolesGuard } = compiled('common/guards/roles.guard.js');
const { JwtAuthGuard } = compiled('common/guards/jwt-auth.guard.js');
const { HmacTamperGuard } = compiled('common/guards/hmac-tamper.guard.js');
const { TelemetryAuthGuard } = compiled('modules/safety/telemetry-auth.guard.js');
const { ScoutOutreachGuard } = compiled('modules/scouts/scout-outreach.guard.js');
const { ScoutsDossiersService } = compiled('modules/scouts/dossiers.service.js');
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const settings = {
  'auth.identityPepper': 'synthetic-audit-pepper',
  'auth.drillHmacSecret': 'synthetic-audit-drill-secret',
  'auth.telemetryHmacSecret': 'synthetic-audit-telemetry-secret',
  'auth.jwtPublicKeyPath': '/nonexistent/audit-public.pem',
  'auth.jwtPrivateKeyPath': '/nonexistent/audit-private.pem',
  'app.nodeEnv': 'test',
};
const config = { get: (key, fallback) => settings[key] ?? fallback };
const memory = new Map();
const redis = {
  get: async (key) => memory.get(key) ?? null,
  set: async (key, value) => {
    memory.set(key, value);
  },
  setnx: async (key, value) => {
    if (memory.has(key)) return false;
    memory.set(key, value);
    return true;
  },
  del: async (key) => {
    memory.delete(key);
  },
  deleteIfValueMatches: async (key, value) => memory.get(key) === value && memory.delete(key),
};
function context(request) {
  const reply = {
    statusCode: 201,
    header: () => reply,
    status: (code) => {
      reply.statusCode = code;
      return reply;
    },
  };
  return {
    getHandler: () => function syntheticHandler() {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  };
}
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timed out')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const results = [];
  const interceptor = new IdempotencyInterceptor(redis);
  const request = {
    method: 'POST',
    url: '/api/v1/tournaments/t/brackets/b/free-agents/join',
    ip: '127.0.0.1',
    headers: { 'idempotency-key': 'same-synthetic-key-123456' },
    body: { primary_role: 'BATSMAN' },
  };
  let executions = 0;
  // Intercept resolves to an Observable; execute each handler explicitly.
  async function invoke(owner) {
    return firstValueFrom(
      await interceptor.intercept(context({ ...request, user: { sub: owner } }), {
        handle: () => {
          executions++;
          return of({ owner });
        },
      }),
    );
  }
  const first = await invoke('athlete-A');
  const second = await invoke('athlete-B');
  assert.equal(first.owner, 'athlete-A');
  assert.equal(second.owner, 'athlete-B');
  assert.equal(executions, 2);
  results.push({
    probe: 'cross_user_idempotency',
    status: 'PASS',
    handlerExecutions: executions,
    returnedOwners: [first.owner, second.owner],
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const body = {
    athlete_id: ACTOR,
    drill_type: 'BOWLING',
    form_score: 90,
    timestamp,
    sport: 'CRICKET',
    frames_analyzed: 300,
    flaw_flags: [],
  };
  const sign = (input) =>
    crypto.createHmac('sha256', settings['auth.drillHmacSecret']).update(input).digest('hex');
  const legacy = sign(`${ACTOR}:BOWLING:90:${timestamp}`);
  const guard = new DrillSignatureGuard(config, {
    securityAuditLog: { create: async ({ data }) => data },
  });
  assert.equal(
    await guard.canActivate(
      context({ headers: { 'x-drill-signature': legacy }, body, user: { sub: ACTOR } }),
    ),
    true,
  );
  await assert.rejects(
    () =>
      guard.canActivate(
        context({
          headers: { 'x-drill-signature': legacy },
          body: { ...body, sport: 'FOOTBALL', frames_analyzed: 999999, flaw_flags: ['changed'] },
          user: { sub: ACTOR },
        }),
      ),
    ForbiddenException,
  );
  const full = sign(fullDrillPayload(ACTOR, body));
  for (const mutation of [
    { sport: 'FOOTBALL' },
    { frames_analyzed: 301 },
    { flaw_flags: ['changed'] },
  ])
    await assert.rejects(
      () =>
        guard.canActivate(
          context({
            headers: { 'x-drill-signature': full, 'x-drill-signed-fields': 'full' },
            body: { ...body, ...mutation },
            user: { sub: ACTOR },
          }),
        ),
      ForbiddenException,
    );
  results.push({
    probe: 'unsigned_drill_metadata',
    status: 'PASS',
    originalTamperRejected: true,
    fullPayloadMutationsRejected: 3,
  });

  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  let status;
  await assert.rejects(
    pipe.transform({ email: 'synthetic@example.test' }, { type: 'body', metatype: LoginDto }),
    (error) => {
      assert.ok(error instanceof BadRequestException);
      status = error.getStatus();
      return status === 400;
    },
  );
  results.push({
    probe: 'missing_login_government_id',
    status: 'PASS',
    httpStatus: status,
    serviceInvoked: false,
  });

  const service = new MatchmakingService({}, {}, {});
  const candidates = [
    { primaryRole: 'BATSMAN', secondaryRole: 'BOWLER' },
    { primaryRole: 'BATSMAN', secondaryRole: null },
    { primaryRole: 'ALL_ROUNDER', secondaryRole: null },
    { primaryRole: 'WICKETKEEPER', secondaryRole: null },
  ];
  const roster = service.matchCandidatesToSlots(
    candidates,
    service.getSlotRequirements('CRICKET', 4),
  );
  assert.ok(roster);
  assert.equal(roster.length, 4);
  assert.equal(new Set(roster.map((item) => item.candidate)).size, 4);
  assert.equal(roster.find((item) => item.slotName === 'BOWLER').candidate, candidates[0]);
  assert.equal(roster.find((item) => item.slotName === 'BATSMAN').candidate, candidates[1]);
  results.push({
    probe: 'greedy_role_assignment',
    status: 'PASS',
    roster: roster.map((item) => ({
      slot: item.slotName,
      primaryRole: item.candidate.primaryRole,
      secondaryRole: item.candidate.secondaryRole,
    })),
  });

  const prisma = {
    user: {
      findUnique: async () => ({
        id: ACTOR,
        role: 'ATHLETE',
        isActive: true,
        identityRecord: { status: 'VERIFIED' },
      }),
    },
  };
  const strategy = new JwtStrategy(config, prisma);
  const wsAuth = new WsAuthGuard(strategy);
  const gateway = new WsEventGateway(wsAuth, new RoomAccessService(prisma));
  const http = createServer();
  const sockets = new Server(http, { serveClient: false });
  const namespace = sockets.of('/ws/events');
  gateway.server = namespace;
  gateway.afterInit(namespace);
  let ready;
  const authorizedReady = new Promise((resolve) => {
    ready = resolve;
  });
  namespace.on('connection', (socket) => {
    void gateway.handleConnection(socket).then(() => ready());
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}/ws/events`;
  const anonymous = io(origin, {
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
  });
  const authorized = io(origin, {
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
    auth: {
      token: jwt.sign({ sub: ACTOR, role: 'ATHLETE' }, settings['auth.identityPepper'], {
        expiresIn: 60,
      }),
    },
  });
  let leaked = 0;
  let connected = false;
  anonymous.on('MATCH_PAUSE_ALERT', () => {
    leaked++;
  });
  anonymous.on('connect', () => {
    connected = true;
  });
  try {
    await deadline(
      new Promise((resolve, reject) => {
        anonymous.once('connect_error', resolve);
        anonymous.once('connect', () => reject(new Error('Anonymous namespace connected')));
        anonymous.connect();
      }),
    );
    await deadline(
      new Promise((resolve, reject) => {
        authorized.once('connect', resolve);
        authorized.once('connect_error', reject);
        authorized.connect();
      }),
    );
    await deadline(authorizedReady);
    const received = deadline(
      new Promise((resolve) => authorized.once('MATCH_PAUSE_ALERT', resolve)),
    );
    gateway.broadcastAutonomousMatchPause({
      event: 'MATCH_PAUSE_ALERT',
      severity: 'CRITICAL',
      athlete_id: ACTOR,
      athlete_name: 'Synthetic athlete',
      vitals: { heart_rate: 205, spo2: 88, skin_temperature: 40 },
      directive: 'Synthetic probe only',
    });
    const event = await received;
    assert.equal(event.athlete_id, ACTOR);
    assert.equal(leaked, 0);
    assert.equal(connected, false);
    assert.equal(anonymous.connected, false);
    let disconnected = false;
    await gateway.handleConnection({
      handshake: { auth: {}, headers: {}, query: {} },
      data: {},
      disconnect: () => {
        disconnected = true;
      },
    });
    assert.equal(disconnected, true);
    results.push({
      probe: 'anonymous_safety_broadcast',
      status: 'PASS',
      anonymousConnected: connected,
      anonymousMedicalEvents: leaked,
      disconnected,
      authorizedMedicalEvents: 1,
    });
  } finally {
    anonymous.disconnect();
    authorized.disconnect();
    await new Promise((resolve) => sockets.close(resolve));
  }

  const domains = [
    'auth',
    'users',
    'passport',
    'tournaments',
    'brackets',
    'matchmaking',
    'drills',
    'safety',
    'gti',
    'scouts',
    'heatmaps',
    'admin',
    'health',
  ];
  const classes = domains.map((domain) => {
    const name = domain[0].toUpperCase() + domain.slice(1);
    return {
      controller: compiled(`modules/${domain}/${domain}.controller.js`)[`${name}Controller`],
      service: compiled(`modules/${domain}/${domain}.service.js`)[`${name}Service`],
    };
  });
  classes.push({
    controller: compiled('modules/tournaments/match-results.controller.js').MatchResultsController,
    service: compiled('modules/tournaments/match-results.service.js').MatchResultsService,
  });
  classes.push({
    controller: compiled('modules/tournaments/organizer.controller.js').OrganizerController,
    service: compiled('modules/tournaments/organizer.service.js').OrganizerService,
  });
  // The controller needs the organizer service only; this inventory never executes handlers.
  class InventoryModule {}
  Module({
    controllers: classes.map((item) => item.controller),
    providers: [
      ...classes.map((item) => ({ provide: item.service, useValue: {} })),
      { provide: ScoutsDossiersService, useValue: {} },
      { provide: ConfigService, useValue: config },
      { provide: RedisService, useValue: redis },
      { provide: PrismaService, useValue: prisma },
      { provide: JwtStrategy, useValue: strategy },
      IdempotencyInterceptor,
      JwtAuthGuard,
      RolesGuard,
      HmacTamperGuard,
      DrillSignatureGuard,
      TelemetryAuthGuard,
      ScoutOutreachGuard,
    ],
  })(InventoryModule);
  const app = await NestFactory.create(InventoryModule, new FastifyAdapter(), { logger: false });
  let inventory;
  try {
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Verified backend route inventory')
        .setVersion('1')
        .addBearerAuth()
        .build(),
    );
    fs.writeFileSync(
      path.join(__dirname, 'openapi.json'),
      JSON.stringify(document, null, 2) + '\n',
    );
    inventory = Object.entries(document.paths).flatMap(([url, operations]) =>
      Object.entries(operations)
        .filter(([method]) => ['get', 'post', 'patch', 'delete', 'put'].includes(method))
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          path: url,
          operationId: operation.operationId,
        })),
    );
    fs.writeFileSync(
      path.join(__dirname, 'route-inventory.json'),
      JSON.stringify(inventory, null, 2) + '\n',
    );
  } finally {
    await app.close();
  }
  const report = {
    verifiedAt: new Date().toISOString(),
    baseCommit: require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
      .trim(),
    bundle: 'dist/',
    result: 'PASS',
    passed: results.length,
    failed: 0,
    probes: results,
    httpOperations: inventory.length,
    httpPaths: new Set(inventory.map((item) => item.path)).size,
    limitations: [
      'Synthetic dependencies for cache, identity state and route inventory',
      'Real loopback Socket.IO; Redis adapter and physical sensors are not exercised by these five probes',
    ],
  };
  fs.writeFileSync(
    path.join(__dirname, 'probe-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
main().catch((error) => {
  process.stderr.write(String(error.stack ?? error) + '\n');
  process.exitCode = 1;
});
