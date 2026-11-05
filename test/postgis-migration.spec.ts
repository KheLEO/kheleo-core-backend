import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { Prisma, SportType } from '@prisma/client';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { PostgisSpatialRepository } from '../src/infrastructure/database/postgis-spatial.repository';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { LeaderboardsService } from '../src/modules/leaderboards/leaderboards.service';
import { LeaderboardScope } from '../src/modules/leaderboards/leaderboards.dto';
import { HeatmapsService } from '../src/modules/heatmaps/heatmaps.service';

interface GeometryRow {
  readonly lng: number | null;
  readonly lat: number | null;
  readonly srid: number | null;
}

describe('PostGIS baseline migration', () => {
  const database = new PGlite({ extensions: { postgis } });

  before(async () => {
    const migrations = resolve(__dirname, '../prisma/migrations');
    for (const entry of readdirSync(migrations, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await database.exec(readFileSync(resolve(migrations, entry.name, 'migration.sql'), 'utf8'));
    }
  });

  after(async () => {
    await database.close();
  });

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    await database.query('INSERT INTO users (id, updated_at) VALUES ($1, now())', [userId]);
    return userId;
  }

  async function createAthlete(district: string): Promise<string> {
    const userId = await createUser();
    const athleteId = randomUUID();
    await database.query(
      `
      INSERT INTO athlete_profiles (
        id, user_id, date_of_birth, gender, primary_sport, district, state,
        location_lat, location_lng, gti, updated_at
      ) VALUES ($1, $2, '2000-01-01', 'FEMALE', 'CRICKET', $3, 'Maharashtra', 19.076, 72.8777, 67, now())
    `,
      [athleteId, userId, district],
    );
    return athleteId;
  }

  async function createTournament(
    lat: number,
    lng: number,
    tournamentId: string = randomUUID(),
  ): Promise<string> {
    const userId = await createUser();
    await database.query(
      `
      INSERT INTO tournaments (
        id, organizer_id, title, sport, status, max_teams, team_size, venue_name,
        venue_lat, venue_lng, registration_deadline, start_date, end_date, updated_at
      ) VALUES ($1, $2, 'Migration test', 'CRICKET', 'REGISTRATION_OPEN', 8, 11, 'Test ground',
        $3, $4, now() + interval '1 day', now() + interval '2 days', now() + interval '3 days', now())
    `,
      [tournamentId, userId, lat, lng],
    );
    return tournamentId;
  }

  it('creates every Prisma table, scalar column, enum, and foreign key', async () => {
    const tables = await database.query<{ readonly name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = new Set(tables.rows.map((row) => row.name));
    for (const model of Prisma.dmmf.datamodel.models) {
      const tableName = model.dbName ?? model.name;
      assert.ok(names.has(tableName), `Missing table ${tableName}`);
      const columns = await database.query<{ readonly name: string }>(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [tableName],
      );
      const columnNames = new Set(columns.rows.map((row) => row.name));
      for (const field of model.fields.filter((entry) => entry.kind !== 'object')) {
        assert.ok(
          columnNames.has(field.dbName ?? field.name),
          `Missing column ${tableName}.${field.name}`,
        );
      }
    }
    for (const enumeration of Prisma.dmmf.datamodel.enums) {
      const values = await database.query<{ readonly value: string }>(
        `
        SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = $1 ORDER BY e.enumsortorder
      `,
        [enumeration.dbName ?? enumeration.name],
      );
      assert.deepEqual(
        values.rows.map((row) => row.value),
        enumeration.values.map((value) => value.dbName ?? value.name),
      );
    }
    const foreignKeys = await database.query<{ readonly count: number }>(`
      SELECT count(*)::int AS count FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
    `);
    const expected = Prisma.dmmf.datamodel.models
      .flatMap((model) => model.fields)
      .filter((field) => (field.relationFromFields?.length ?? 0) > 0).length;
    assert.equal(foreignKeys.rows[0]?.count, expected);
  });

  it('synchronizes tournament geometry on insert and independent coordinate updates', async () => {
    const id = await createTournament(28.6139, 77.209);
    const geometry = async (): Promise<GeometryRow | undefined> =>
      (
        await database.query<GeometryRow>(
          'SELECT ST_X(location) AS lng, ST_Y(location) AS lat, ST_SRID(location) AS srid FROM tournaments WHERE id = $1',
          [id],
        )
      ).rows[0];
    assert.deepEqual(await geometry(), { lng: 77.209, lat: 28.6139, srid: 4326 });
    await database.query('UPDATE tournaments SET venue_lat = 28.7 WHERE id = $1', [id]);
    assert.deepEqual(await geometry(), { lng: 77.209, lat: 28.7, srid: 4326 });
    await database.query('UPDATE tournaments SET venue_lng = 77.3 WHERE id = $1', [id]);
    assert.deepEqual(await geometry(), { lng: 77.3, lat: 28.7, srid: 4326 });
  });

  it('synchronizes athlete geometry and clears it when either coordinate is removed', async () => {
    const id = await createAthlete('Migration geometry');
    const geometry = async (): Promise<GeometryRow | undefined> =>
      (
        await database.query<GeometryRow>(
          'SELECT ST_X(location) AS lng, ST_Y(location) AS lat, ST_SRID(location) AS srid FROM athlete_profiles WHERE id = $1',
          [id],
        )
      ).rows[0];
    assert.deepEqual(await geometry(), { lng: 72.8777, lat: 19.076, srid: 4326 });
    await database.query('UPDATE athlete_profiles SET location_lat = 20 WHERE id = $1', [id]);
    assert.deepEqual(await geometry(), { lng: 72.8777, lat: 20, srid: 4326 });
    await database.query('UPDATE athlete_profiles SET location_lng = 73 WHERE id = $1', [id]);
    assert.deepEqual(await geometry(), { lng: 73, lat: 20, srid: 4326 });
    await database.query('UPDATE athlete_profiles SET location_lat = NULL WHERE id = $1', [id]);
    assert.deepEqual(await geometry(), { lng: null, lat: null, srid: null });
    await database.query(
      'UPDATE athlete_profiles SET location_lat = 19, location_lng = NULL WHERE id = $1',
      [id],
    );
    assert.deepEqual(await geometry(), { lng: null, lat: null, srid: null });
  });

  it('creates GiST indexes and uses the geography index for meter-based discovery', async () => {
    const indexes = await database.query<{ readonly name: string; readonly definition: string }>(
      "SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%_location_%gist'",
    );
    assert.equal(indexes.rows.length, 3);
    for (const row of indexes.rows) assert.match(row.definition, /USING gist/i);
    await database.exec('SET enable_seqscan = off');
    try {
      const plan = await database.query<{ readonly 'QUERY PLAN': string }>(`
        EXPLAIN SELECT id FROM tournaments WHERE ST_DWithin(
          location::geography, ST_SetSRID(ST_MakePoint(72.8777, 19.076), 4326)::geography, 1000
        )
      `);
      assert.match(
        plan.rows.map((row) => row['QUERY PLAN']).join('\n'),
        /idx_tournaments_location_geography_gist/,
      );
    } finally {
      await database.exec('RESET enable_seqscan');
    }
  });

  it('runs the production tournament discovery query against the migrated schema', async () => {
    const id = await createTournament(19.076, 72.8777);
    const prisma = {
      $queryRaw: async (query: Prisma.Sql): Promise<unknown> =>
        (await database.query(query.text, query.values)).rows,
    };
    const repository = new PostgisSpatialRepository(prisma as unknown as PrismaService);
    const rows = await repository.findTournamentsWithinRadius(
      { lat: 19.076, lng: 72.8777 },
      1,
      SportType.CRICKET,
    );
    const tournament = rows.data.find((row) => row.id === id);
    assert.ok(tournament);
    assert.equal(tournament.distance_km, 0);
    assert.equal(tournament.name, 'Migration test');
    const distant = await repository.findTournamentsWithinRadius(
      { lat: 0, lng: 0 },
      1,
      SportType.CRICKET,
    );
    assert.equal(distant.data.length, 0);
  });

  it('runs the production heatmap query using synchronized athlete geometry', async () => {
    const district = 'Migration heatmap';
    await createAthlete(district);
    const prisma = {
      $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
        const sql = Prisma.sql(query, ...values);
        return (await database.query(sql.text, sql.values)).rows;
      },
    };
    const service = new HeatmapsService(prisma as unknown as PrismaService);
    const result = await service.getRegionalHeatmap();
    const row = result.data.find((entry) => entry.district === district);
    assert.ok(row);
    assert.equal(row.total_athletes, 1);
    assert.equal(row.average_gti, 67);
    assert.equal(row.female_participation_pct, 100);
    assert.deepEqual(row.centroid, { type: 'Point', coordinates: [72.8777, 19.076] });
  });

  it('enforces unique and foreign keys and retains audit logs after actor deletion', async () => {
    const userId = await createUser();
    const logId = randomUUID();
    await database.query(
      'INSERT INTO security_audit_logs (id, user_id, action) VALUES ($1, $2, $3)',
      [logId, userId, 'TEST_ACTION'],
    );
    await assert.rejects(
      database.query('INSERT INTO users (id, updated_at) VALUES ($1, now())', [userId]),
      /unique constraint/,
    );
    await assert.rejects(
      database.query('UPDATE security_audit_logs SET action=$1 WHERE id=$2', ['CHANGED', logId]),
      /append-only/,
    );
    await assert.rejects(
      database.query('DELETE FROM security_audit_logs WHERE id=$1', [logId]),
      /append-only/,
    );
    await assert.rejects(database.exec('TRUNCATE security_audit_logs'), /append-only/);
    await database.query('DELETE FROM users WHERE id = $1', [userId]);
    const logs = await database.query<{ readonly user_id: string | null; readonly action: string }>(
      'SELECT user_id, action FROM security_audit_logs WHERE id = $1',
      [logId],
    );
    assert.deepEqual(logs.rows, [{ user_id: userId, action: 'TEST_ACTION' }]);
  });

  it('stores incomplete passport demographics as null after the follow-up migration', async () => {
    const userId = await createUser();
    const profileId = randomUUID();
    await database.query(
      "INSERT INTO athlete_profiles (id, user_id, district, state, updated_at) VALUES ($1, $2, '', '', now())",
      [profileId, userId],
    );
    const result = await database.query<{
      readonly date_of_birth: string | null;
      readonly gender: string | null;
      readonly primary_sport: string | null;
    }>('SELECT date_of_birth, gender, primary_sport FROM athlete_profiles WHERE id = $1', [
      profileId,
    ]);
    assert.deepEqual(result.rows, [{ date_of_birth: null, gender: null, primary_sport: null }]);
  });
  it('paginates PostGIS by exact distance then UUID, including zero-distance ties and smaller UUIDs on later pages', async () => {
    const ids = [
      '99999999-9999-4999-8999-999999999999',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '00000000-0000-4000-8000-000000000001',
    ];
    await createTournament(0, 0, ids[0]);
    await createTournament(0, 0, ids[1]);
    await createTournament(0, 0.1, ids[2]);
    const prisma = {
      $queryRaw: async (query: Prisma.Sql): Promise<unknown> =>
        (await database.query(query.text, query.values)).rows,
    };
    const repository = new PostgisSpatialRepository(prisma as unknown as PrismaService);
    const observed: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const rows = await repository.findTournamentsWithinRadius(
        { lat: 0, lng: 0 },
        50,
        SportType.CRICKET,
        1,
        cursor,
      );
      observed.push(...rows.data.map((row) => row.id));
      if (!rows.data[0]) break;
      cursor = rows.data[0].id;
    }
    assert.deepEqual(observed, ids);
    await assert.rejects(
      repository.findTournamentsWithinRadius(
        { lat: 0, lng: 0 },
        50,
        SportType.CRICKET,
        1,
        randomUUID(),
      ),
      /Cursor tournament is not in the current nearby search/,
    );
  });

  it('keeps MATCHED intact when a conditional leave runs after a committed worker update', async () => {
    const userId = await createUser();
    const tournamentId = await createTournament(10, 10);
    const bracketId = randomUUID();
    const registrationId = randomUUID();
    await database.query('INSERT INTO brackets (id, tournament_id, name) VALUES ($1, $2, $3)', [
      bracketId,
      tournamentId,
      'Concurrency test',
    ]);
    await database.query(
      'INSERT INTO free_agent_registrations (id, user_id, tournament_id, bracket_id, sport, primary_role) VALUES ($1, $2, $3, $4, $5, $6)',
      [registrationId, userId, tournamentId, bracketId, 'CRICKET', 'BATSMAN'],
    );
    const before = await database.query<{ readonly status: string }>(
      'SELECT status FROM free_agent_registrations WHERE id = $1',
      [registrationId],
    );
    assert.equal(before.rows[0]?.status, 'QUEUED');
    await database.query("UPDATE free_agent_registrations SET status = 'MATCHED' WHERE id = $1", [
      registrationId,
    ]);
    const leave = await database.query(
      "UPDATE free_agent_registrations SET status = 'CANCELLED' WHERE id = $1 AND user_id = $2 AND status = 'QUEUED' RETURNING id",
      [registrationId, userId],
    );
    assert.equal(leave.rows.length, 0);
    const after = await database.query<{ readonly status: string }>(
      'SELECT status FROM free_agent_registrations WHERE id = $1',
      [registrationId],
    );
    assert.equal(after.rows[0]?.status, 'MATCHED');
  });
  it('captures permanent drill, identity, registration, safety, and result audit snapshots with normalized signatures', async () => {
    const athleteId = await createAthlete('Audit test');
    const owner = await createUser();
    const user = (
      await database.query<{ user_id: string }>(
        'SELECT user_id FROM athlete_profiles WHERE id=$1',
        [athleteId],
      )
    ).rows[0]!.user_id;
    const identityId = randomUUID();
    await database.query(
      `INSERT INTO identity_verifications(id,user_id,id_hash,id_type) VALUES ($1,$2,$3,'AADHAAR')`,
      [identityId, user, randomUUID().replaceAll('-', '').padEnd(64, '0')],
    );
    await database.query('UPDATE identity_verifications SET re_linked_count=1 WHERE id=$1', [
      identityId,
    ]);
    const drillId = randomUUID();
    const hash = 'A'.repeat(64);
    await database.query(
      `INSERT INTO drill_submissions(id,athlete_id,sport,drill_type,form_score,frames_analyzed,flaw_flags,joint_angles_summary,signature_hash,signature_version,metadata_verified) VALUES ($1,$2,'CRICKET','BOWLING',88,300,'[]','{}',$3,'FULL',true)`,
      [drillId, user, hash],
    );
    assert.equal(
      (
        await database.query<{ signature_hash: string }>(
          'SELECT signature_hash FROM drill_submissions WHERE id=$1',
          [drillId],
        )
      ).rows[0]!.signature_hash,
      hash.toLowerCase(),
    );
    await assert.rejects(
      database.query(
        `INSERT INTO drill_submissions(id,athlete_id,sport,drill_type,form_score,frames_analyzed,flaw_flags,joint_angles_summary,signature_hash) VALUES ($1,$2,'CRICKET','BOWLING',88,300,'[]','{}',$3)`,
        [randomUUID(), user, hash.toLowerCase()],
      ),
      /unique constraint/,
    );
    await database.query('UPDATE drill_submissions SET form_score=10 WHERE id=$1', [drillId]);
    const tournamentId = await createTournament(19, 72);
    const bracketId = randomUUID();
    await database.query(`INSERT INTO brackets(id,tournament_id,name) VALUES ($1,$2,'Open')`, [
      bracketId,
      tournamentId,
    ]);
    const regId = randomUUID();
    await database.query(`INSERT INTO registrations(id,bracket_id,user_id) VALUES ($1,$2,$3)`, [
      regId,
      bracketId,
      user,
    ]);
    const teamA = randomUUID(),
      teamB = randomUUID(),
      matchId = randomUUID();
    for (const team of [teamA, teamB])
      await database.query(
        `INSERT INTO teams(id,tournament_id,bracket_id,name) VALUES($1,$2,$3,'Team')`,
        [team, tournamentId, bracketId],
      );
    await database.query(
      `INSERT INTO matches(id,bracket_id,match_number,team_a_id,team_b_id,scheduled_start,status) VALUES($1,$2,1,$3,$4,now(),'PAUSED_SAFETY')`,
      [matchId, bracketId, teamA, teamB],
    );
    const alertId = randomUUID();
    await database.query(
      `INSERT INTO health_alerts(id,athlete_id,tournament_id,bracket_id,match_id,severity,heart_rate,spo2,skin_temperature,trigger_reason,match_paused) VALUES($1,$2,$3,$4,$5,'CRITICAL',200,88,40,'threshold',true)`,
      [alertId, user, tournamentId, bracketId, matchId],
    );
    const resultId = randomUUID();
    await database.query(
      `INSERT INTO verified_match_results(id,bracket_id,match_id,reported_by_id,request_key,fingerprint,participant_athlete_ids,winner_athlete_ids) VALUES($1,$2,$3,$4,$5,$6,ARRAY[$7::uuid,$4::uuid],ARRAY[$7::uuid])`,
      [resultId, bracketId, matchId, owner, 'b'.repeat(64), 'c'.repeat(64), user],
    );
    const audit = await database.query<{
      action: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }>(
      'SELECT action,resource_id,metadata FROM security_audit_logs WHERE resource_id=ANY($1::text[])',
      [[drillId, identityId, regId, alertId, resultId]],
    );
    assert.deepEqual(
      new Set(audit.rows.map((row) => row.action)),
      new Set([
        'DRILL_SUBMITTED',
        'GOV_ID_RELINK_ATTEMPT',
        'TOURNAMENT_REGISTRATION',
        'SAFETY_MATCH_PAUSED',
        'VERIFIED_MATCH_RESULT',
      ]),
    );
    const drill = audit.rows.find((row) => row.resource_id === drillId)!;
    assert.equal(drill.metadata.formScore, 88);
    assert.equal(drill.metadata.metadataVerified, true);
    const safety = audit.rows.find((row) => row.resource_id === alertId)!;
    assert.equal(safety.metadata.matchId, matchId);
    assert.equal('heart_rate' in safety.metadata, false);
    await database.query('DELETE FROM drill_submissions WHERE id=$1', [drillId]);
    assert.equal(
      (await database.query('SELECT id FROM security_audit_logs WHERE resource_id=$1', [drillId]))
        .rows.length,
      1,
    );
  });

  it('runs the production leaderboard SQL with deterministic ranks, state/district scope, and fallback cursors', async () => {
    const seeded: Array<{ userId: string; profileId: string }> = [];
    for (let n = 0; n < 4; n++) {
      const profileId = await createAthlete('Leaderboard district');
      const userId = (
        await database.query<{ user_id: string }>(
          'SELECT user_id FROM athlete_profiles WHERE id=$1',
          [profileId],
        )
      ).rows[0]!.user_id;
      await database.query(
        `INSERT INTO identity_verifications(id,user_id,id_hash,id_type) VALUES($1,$2,$3,'AADHAAR')`,
        [randomUUID(), userId, randomUUID().replaceAll('-', '').padEnd(64, '0')],
      );
      await database.query(
        `UPDATE athlete_profiles SET state=$2,gti=$3,current_gti=$4,biomechanical_score=95,training_consistency_score=90,match_performance_score=85 WHERE id=$1`,
        [profileId, n === 3 ? 'Karnataka' : 'Maharashtra', n === 0 ? 0 : 88, n === 0 ? 92 : 88],
      );
      seeded.push({ userId, profileId });
    }
    await database.query('UPDATE users SET is_active=false WHERE id=$1', [seeded[2]!.userId]);
    const prisma = {
      $queryRaw: async (query: Prisma.Sql): Promise<unknown> =>
        (await database.query(query.text, query.values)).rows,
      athleteProfile: { count: async () => 0 },
    } as unknown as PrismaService;
    const redis = {
      client: {
        zcard: async () => {
          throw new Error('Redis unavailable');
        },
      },
    } as unknown as RedisService;
    const service = new LeaderboardsService(prisma, redis);
    const query = {
      sport: SportType.CRICKET,
      scope: LeaderboardScope.DISTRICT,
      state: 'Maharashtra',
      district: 'Leaderboard district',
      limit: 1,
    };
    const first = await service.list(query);
    assert.equal(first.source, 'database');
    assert.equal(first.data.length, 1);
    assert.equal(first.data[0]!.athleteId, seeded[0]!.userId);
    assert.equal(first.data[0]!.gti, 92);
    assert.equal(first.data[0]!.rank, 1);
    assert.equal(first.data[0]!.wearableScore, 90);
    assert.ok(first.nextCursor);
    const second = await service.list({ ...query, cursor: first.nextCursor! });
    assert.equal(second.data[0]!.athleteId, seeded[1]!.userId);
    assert.equal(second.data[0]!.rank, 2);
    assert.equal(second.nextCursor, null);
    const other = await service.list({ ...query, state: 'Karnataka' });
    assert.equal(other.data[0]!.athleteId, seeded[3]!.userId);
    assert.equal(await service.rank(SportType.CRICKET, seeded[2]!.userId), null);
    await database.query('UPDATE athlete_profiles SET is_scout_searchable=false WHERE id=$1', [
      seeded[0]!.profileId,
    ]);
    const hidden = await service.list(query);
    assert.equal(hidden.data[0]!.athleteId, seeded[1]!.userId);
    assert.equal(hidden.data[0]!.rank, 1);
  });
  it('stores telemetry provenance and enforces pose-digest uniqueness in migrated PostgreSQL', async () => {
    const userId = await createUser();
    const insert = (digest: string | null): Promise<unknown> =>
      database.query(
        `
      INSERT INTO drill_submissions
        (id, athlete_id, sport, drill_type, form_score, frames_analyzed, flaw_flags, joint_angles_summary, signature_hash, client_pose_digest)
      VALUES ($1, $2, 'CRICKET', 'CRICKET_BOWLING', 80, 150, '[]', '{}', $3, $4)
    `,
        [randomUUID(), userId, randomUUID().replaceAll('-', '').padEnd(64, '0'), digest],
      );
    await insert('a'.repeat(64));
    await assert.rejects(insert('a'.repeat(64)), /unique constraint/);
    await insert(null);
    await insert(null);
    await database.query(
      `INSERT INTO wearable_sessions (id, athlete_id, session_date, source, baseline_fields)
      VALUES ($1, $2, CURRENT_DATE, 'BLE', ARRAY['spo2','skin_temperature'])`,
      [randomUUID(), userId],
    );
    const row = await database.query<{ source: string; baseline_fields: string[] }>(
      'SELECT source, baseline_fields FROM wearable_sessions WHERE athlete_id=$1',
      [userId],
    );
    assert.equal(row.rows[0]?.source, 'BLE');
    assert.deepEqual(row.rows[0]?.baseline_fields, ['spo2', 'skin_temperature']);
    await database.query("UPDATE wearable_sessions SET source='SIMULATOR' WHERE athlete_id=$1", [
      userId,
    ]);
  });
});
