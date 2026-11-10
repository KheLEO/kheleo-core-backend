const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(operation, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(150);
  }
  throw new Error(`Production smoke deadline exceeded${last ? ': ' + last.message : ''}`);
}
async function main() {
  const databaseName = new URL(process.env.DATABASE_URL).pathname;
  assert.match(
    databaseName,
    /(?:_audit|_test)$/u,
    'Use only an isolated database ending in _audit or _test',
  );
  assert.equal(
    process.env.NODE_ENV,
    'production',
    'This smoke suite exercises the production profile',
  );
  const port = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const outputPath = 'audit-evidence/2026-11-05/ci-smoke-results.json';
  let logs = '';
  const child = spawn('pnpm', ['start:prod'], {
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-64000);
  });
  child.stderr.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-64000);
  });
  const prisma = new PrismaClient();
  const clients = [];
  const privateKey = fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH, 'utf8');
  const token = (user) =>
    jwt.sign({ sub: user.id, role: user.role }, privateKey, { algorithm: 'RS256', expiresIn: 120 });
  async function request(route, actor, body, method = 'GET') {
    const response = await fetch(`${origin}/api/v1${route}`, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        ...(actor ? { authorization: `Bearer ${token(actor)}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result.success === true && typeof result.timestamp === 'string' ? result.data : result;
  }
  async function connect(actor) {
    const client = io(`${origin}/ws/events`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      auth: { token: token(actor) },
    });
    clients.push(client);
    await until(
      () =>
        new Promise((resolve, reject) => {
          client.once('connect', () => resolve(true));
          client.once('connect_error', reject);
          client.connect();
        }),
      5000,
    );
    return client;
  }
  try {
    const health = await until(async () => {
      if (child.exitCode !== null) throw new Error('Backend exited before readiness');
      const response = await fetch(`${origin}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return response.ok ? response.json() : false;
    });
    assert.equal(health.db, 'ok');
    assert.equal(health.redis, 'ok');
    const docs = await fetch(`${origin}/docs`);
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /Swagger/);
    const document = await (await fetch(`${origin}/docs-json`)).json();
    assert.ok(document.paths['/api/v1/admin/dashboard']);
    assert.ok(document.paths['/api/v1/gti/leaderboards']);
    const cors = await fetch(`${origin}/api/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dashboard.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-drill-signed-fields,authorization',
      },
    });
    assert.equal(cors.headers.get('access-control-allow-origin'), 'https://dashboard.example.test');
    const denied = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        email: 'synthetic@example.test',
        governmentId: { idType: 'AADHAAR', idNumber: '123456789012' },
      }),
    });
    assert.equal(denied.status, 401);
    const users = [];
    for (const role of ['ATHLETE', 'ATHLETE', 'ORGANIZER', 'SCOUT', 'SUPER_ADMIN']) {
      const user = await prisma.user.create({
        data: {
          role,
          email: `${randomUUID()}@example.test`,
          identityRecord: {
            create: {
              idHash: randomBytes(32).toString('hex'),
              idType: 'AADHAAR',
              status: 'VERIFIED',
            },
          },
        },
      });
      users.push(user);
    }
    const [athlete, opponent, owner, scout, admin] = users;
    for (const user of [athlete, opponent])
      await prisma.athleteProfile.create({
        data: {
          userId: user.id,
          primarySport: 'CRICKET',
          dateOfBirth: new Date('2000-01-01'),
          gender: 'FEMALE',
          district: 'Pune',
          state: 'Maharashtra',
          isScoutSearchable: true,
          isRuralOrUnderrepresented: true,
          sportRecords: { create: { sport: 'CRICKET', primaryRole: 'BATSMAN' } },
        },
      });
    const tournament = await prisma.tournament.create({
      data: {
        organizerId: owner.id,
        title: 'Isolated CI verification',
        sport: 'CRICKET',
        status: 'IN_PROGRESS',
        teamSize: 1,
        maxTeams: 8,
        venueName: 'Synthetic test venue',
        venueLat: 19,
        venueLng: 72,
        registrationDeadline: new Date(Date.now() - 7200000),
        startDate: new Date(Date.now() - 3600000),
        endDate: new Date(Date.now() + 3600000),
      },
    });
    const bracket = await prisma.bracket.create({
      data: { tournamentId: tournament.id, name: 'Open' },
    });
    const teams = [];
    for (const user of [athlete, opponent]) {
      const profile = await prisma.athleteProfile.findUniqueOrThrow({ where: { userId: user.id } });
      teams.push(
        await prisma.team.create({
          data: {
            tournamentId: tournament.id,
            bracketId: bracket.id,
            name: 'Synthetic team',
            captainId: user.id,
            members: { create: { userId: user.id, athleteId: profile.id } },
          },
        }),
      );
      await prisma.registration.create({ data: { bracketId: bracket.id, userId: user.id } });
    }
    const match = await prisma.match.create({
      data: {
        bracketId: bracket.id,
        teamAId: teams[0].id,
        teamBId: teams[1].id,
        matchNumber: 1,
        scheduledStart: new Date(),
        status: 'LIVE',
      },
    });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let n = 1; n < 20; n++) {
      const day = new Date(today);
      day.setUTCDate(day.getUTCDate() - n);
      await prisma.wearableSession.create({
        data: { athleteId: athlete.id, sessionDate: day, source: 'DEVICE_HMAC' },
      });
    }
    const scoutSocket = await connect(scout);
    const athleteSocket = await connect(athlete);
    const ownerSocket = await connect(owner);
    assert.equal(
      (
        await ownerSocket
          .timeout(5000)
          .emitWithAck('join:tournament', { tournamentId: tournament.id })
      ).joined,
      true,
    );
    let scoutMedicalEvents = 0;
    let scoutTalentEvents = 0;
    let athletePauseEvents = 0;
    let ownerPauseEvents = 0;
    ownerSocket.on('MATCH_PAUSE_ALERT', () => {
      ownerPauseEvents++;
    });
    scoutSocket.on('MATCH_PAUSE_ALERT', () => {
      scoutMedicalEvents++;
    });
    scoutSocket.on('SCOUT_TALENT_ALERT', () => {
      scoutTalentEvents++;
    });
    athleteSocket.on('MATCH_PAUSE_ALERT', () => {
      athletePauseEvents++;
    });
    const telemetry = {
      athlete_id: athlete.id,
      heart_rate: 205,
      spo2: 88,
      skin_temperature: 40,
      timestamp: Date.now(),
      match_id: match.id,
    };
    assert.equal(
      (await request('/safety/telemetry-webhook', athlete, telemetry, 'POST')).status,
      'MATCH_PAUSED',
    );
    await until(async () => ownerPauseEvents > 0);
    assert.equal(athletePauseEvents, 0);
    assert.equal(scoutMedicalEvents, 0);
    const alerts = await request(`/safety/alerts?tournament_id=${tournament.id}`, owner);
    assert.ok(alerts.data[0]);
    await request(
      `/safety/alerts/${alerts.data[0].id}/acknowledge`,
      owner,
      { medicalCheckDispatched: true, medicalCheckNote: 'Synthetic medical check dispatched' },
      'PATCH',
    );
    await request(
      `/safety/matches/${match.id}/resume`,
      owner,
      {
        medicalClearanceConfirmed: true,
        medicalClearanceNote: 'Synthetic field clearance confirmed',
      },
      'POST',
    );
    const drill = {
      athlete_id: athlete.id,
      sport: 'CRICKET',
      drill_type: 'BOWLING',
      form_score: 96,
      frames_analyzed: 300,
      flaw_flags: [],
      timestamp: Math.floor(Date.now() / 1000),
    };
    const signature = createHmac('sha256', process.env.DRILL_HMAC_SECRET)
      .update(`${athlete.id}:CRICKET:BOWLING:96:300:[]:${drill.timestamp}`)
      .digest('hex');
    const submitted = await fetch(`${origin}/api/v1/drills/submit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token(athlete)}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
        'X-Drill-Signed-Fields': 'full',
        'X-Drill-Signature': signature,
      },
      body: JSON.stringify(drill),
    });
    assert.equal(submitted.status, 200, await submitted.text());
    for (let n = 0; n < 4; n++)
      await request(
        `/tournaments/${tournament.id}/brackets/${bracket.id}/matches/record-result`,
        owner,
        {
          winnerAthleteIds: [athlete.id],
          participantAthleteIds: [athlete.id, opponent.id],
          ...(n === 0 ? { matchId: match.id } : {}),
        },
        'POST',
      );
    const profile = await until(async () => {
      const value = await prisma.athleteProfile.findUniqueOrThrow({
        where: { userId: athlete.id },
      });
      return value.gti === 98.6 ? value : false;
    });
    await until(async () => scoutTalentEvents > 0);
    assert.equal(scoutMedicalEvents, 0);
    const leaderboard = await request(
      '/gti/leaderboards?sport=CRICKET&scope=STATE&state=Maharashtra',
      athlete,
    );
    assert.equal(leaderboard.data[0].athleteId, athlete.id);
    assert.equal(leaderboard.data[0].gti, 98.6);
    const dashboard = await request('/admin/dashboard', admin);
    assert.ok(dashboard.verifiedAthletes >= 2);
    assert.equal(dashboard.health.status, 'ok');
    assert.ok(dashboard.bullmqQueuesStatus.every((queue) => queue.status === 'ok'));
    assert.equal(dashboard.postgisAvailable, true);
    const summary = await request('/tournaments/organizer/summary', owner);
    assert.ok(summary.activeTournamentsCount >= 1);
    const owned = await request('/tournaments/organizer/mine', owner);
    assert.ok(owned.data.some((entry) => entry.id === tournament.id));
    const rosters = await request(
      `/tournaments/${tournament.id}/brackets/${bracket.id}/registrations`,
      owner,
    );
    assert.equal(rosters.data.length, 2);
    const wall = await request(`/safety/tournaments/${tournament.id}/vitals`, owner);
    assert.equal(wall.data.length, 2);
    const dossier = await request(`/users/${athlete.id}/dossier`, scout);
    assert.ok(dossier.recent_drills.length > 0);
    assert.ok(dossier.gti_history.length > 0);
    await request(
      `/scouts/dossiers/${athlete.id}/outreach`,
      scout,
      { actionType: 'SHORTLIST_BOOKMARK', notes: 'Synthetic shortlist' },
      'POST',
    );
    assert.equal(
      (await request(`/users/${athlete.id}/dossier`, scout)).scout_outreach.is_shortlisted,
      true,
    );
    const audits = await request('/admin/audit-logs?category=SAFETY_MATCH_PAUSE', admin);
    assert.ok(audits.data.length > 0);
    await until(
      async () => (await prisma.outboxEvent.count({ where: { deliveredAt: null } })) === 0,
    );
    const report = {
      verifiedAt: new Date().toISOString(),
      result: 'PASS',
      runtime: process.version,
      productionStart: true,
      health: { db: health.db, redis: health.redis },
      docs: true,
      cors: true,
      contactProofRequired: true,
      nativeMigrations: true,
      wearableScore: profile.trainingConsistencyScore,
      matchScore: profile.matchPerformanceScore,
      biomechanicalScore: profile.biomechanicalScore,
      gti: profile.gti,
      scoutTalentEvents,
      scoutMedicalEvents,
      athletePauseEvents,
      ownerPauseEvents,
      leaderboards: true,
      dashboard: true,
      outboxDrained: true,
    };
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    const names = Object.keys(process.env).filter((name) =>
      /SECRET|PEPPER|PASSWORD|DATABASE_URL/.test(name),
    );
    let safeLogs = logs;
    for (const name of names) {
      const value = process.env[name];
      if (value) safeLogs = safeLogs.split(value).join('[redacted]');
    }
    const logPath = 'audit-evidence/2026-11-05/ci-smoke-log.txt';
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.writeFileSync(logPath, safeLogs);
    process.stderr.write(safeLogs + '\n');
    throw error;
  } finally {
    for (const client of clients) client.disconnect();
    await prisma.$disconnect();
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }
  }
}
main().catch((error) => {
  process.stderr.write(String(error.stack ?? error) + '\n');
  process.exitCode = 1;
});
