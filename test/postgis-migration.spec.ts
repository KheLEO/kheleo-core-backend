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

  async function createTournament(lat: number, lng: number): Promise<string> {
    const userId = await createUser();
    const tournamentId = randomUUID();
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
    const tournament = rows.find((row) => row.id === id);
    assert.ok(tournament);
    assert.equal(tournament.distance_km, 0);
    assert.equal(tournament.name, 'Migration test');
    const distant = await repository.findTournamentsWithinRadius(
      { lat: 0, lng: 0 },
      1,
      SportType.CRICKET,
    );
    assert.equal(distant.length, 0);
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
      database.query('INSERT INTO security_audit_logs (id, user_id, action) VALUES ($1, $2, $3)', [
        randomUUID(),
        randomUUID(),
        'INVALID_ACTOR',
      ]),
      /foreign key constraint/,
    );
    await database.query('DELETE FROM users WHERE id = $1', [userId]);
    const logs = await database.query<{ readonly user_id: string | null; readonly action: string }>(
      'SELECT user_id, action FROM security_audit_logs WHERE id = $1',
      [logId],
    );
    assert.deepEqual(logs.rows, [{ user_id: null, action: 'TEST_ACTION' }]);
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
});
