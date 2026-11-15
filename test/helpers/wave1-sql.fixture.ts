import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';

type Row = Record<string, unknown>;
const camel = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase()),
      value,
    ]),
  );

/** SQL-backed repositories: no synthetic score defaults or merged Float/Decimal columns. */
export async function createWave1SqlFixture(withOutbox = false) {
  const db = new PGlite('memory://', { extensions: { postgis } });
  const root = resolve(__dirname, '../../prisma/migrations');
  for (const dir of readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    await db.exec(readFileSync(resolve(root, dir.name, 'migration.sql'), 'utf8'));
  }
  let connection: Pick<PGlite, 'query'> = db;
  const query = <T = Row>(sql: string, params: unknown[] = []) => connection.query<T>(sql, params);
  const findProfile = async (args: Prisma.AthleteProfileFindUniqueArgs) => {
    const column = args.where.userId ? 'user_id' : 'id';
    const raw = (
      await query(`SELECT * FROM athlete_profiles WHERE ${column}=$1`, [
        args.where.userId ?? args.where.id,
      ])
    ).rows[0];
    if (!raw) return null;
    const user = (
      await query(
        'SELECT u.*, i.status AS identity_status FROM users u LEFT JOIN identity_verifications i ON i.user_id=u.id WHERE u.id=$1',
        [raw.user_id],
      )
    ).rows[0]!;
    return {
      ...camel(raw),
      user: {
        ...camel(user),
        _count: { scoutAlerts: 0 },
        identityRecord: user.identity_status ? { status: user.identity_status } : null,
      },
      sportRecords: (
        await query(
          'SELECT * FROM sport_passport_records WHERE athlete_id=$1 ORDER BY id LIMIT 20',
          [raw.id],
        )
      ).rows.map(camel),
    };
  };
  const countRows = (table: string) => ({
    count: async ({ where }: { where: { athleteId: string; readingsCount?: { gt: number } } }) =>
      (
        await query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1 ${where.readingsCount ? 'AND readings_count>0' : ''}`,
          [where.athleteId],
        )
      ).rows[0]!.count,
  });
  const adapter = {
    $queryRaw: async (sql: Prisma.Sql) => (await query(sql.text, sql.values)).rows,
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>) =>
      db.transaction(async (tx) => {
        connection = tx;
        try {
          return await operation(adapter);
        } finally {
          connection = db;
        }
      }),
    athleteProfile: {
      findUnique: findProfile,
      findUniqueOrThrow: async (args: Prisma.AthleteProfileFindUniqueArgs) => {
        const profile = await findProfile(args);
        if (!profile) throw new Error('Missing SQL fixture profile');
        return profile;
      },
      update: async ({ where, data }: Prisma.AthleteProfileUpdateArgs) => {
        const columns: Record<string, string> = {
          gti: 'gti',
          currentGti: 'current_gti',
          biomechanicalScore: 'biomechanical_score',
          trainingConsistencyScore: 'training_consistency_score',
          wearableScore: 'wearable_score',
          matchPerformanceScore: 'match_performance_score',
          matchPerfScore: 'match_perf_score',
        };
        const params: unknown[] = [where.id];
        const assignments = Object.entries(data).map(([key, value]) => {
          if (key === 'posturePoints') {
            params.push((value as Prisma.IntFieldUpdateOperationsInput).increment);
            return `posture_points=posture_points+$${params.length}`;
          }
          if (!columns[key]) throw new Error(`Unsupported SQL fixture update: ${key}`);
          params.push(value instanceof Prisma.Decimal ? value.toNumber() : value);
          return `${columns[key]}=$${params.length}`;
        });
        await query(
          `UPDATE athlete_profiles SET ${assignments.join(',')},updated_at=now() WHERE id=$1`,
          params,
        );
        return findProfile({ where });
      },
      count: async () =>
        (
          await query<{ count: number }>(`SELECT count(*)::int AS count FROM athlete_profiles p
        JOIN users u ON u.id=p.user_id JOIN identity_verifications i ON i.user_id=u.id
        WHERE p.primary_sport='CRICKET' AND p.is_scout_searchable AND u.role='ATHLETE' AND u.is_active AND i.status='VERIFIED'`)
        ).rows[0]!.count,
      findMany: async ({
        where,
      }: {
        where: { AND?: Array<{ userId?: { in: string[] } }>; id?: { in: string[] } };
      }) => {
        if (where.id?.in)
          return Promise.all(where.id.in.map((id) => findProfile({ where: { id } })));
        const ids = where.AND?.find((part) => part.userId)?.userId?.in ?? [];
        return Promise.all(ids.map(async (userId) => findProfile({ where: { userId } })));
      },
    },
    drillSubmission: {
      ...countRows('drill_submissions'),
      findFirst: async ({ where }: { where: { OR: Array<{ signatureHash?: string }> } }) =>
        (
          await query('SELECT id FROM drill_submissions WHERE signature_hash=$1', [
            where.OR[0]!.signatureHash,
          ])
        ).rows[0] ?? null,
      create: async ({ data }: Prisma.DrillSubmissionCreateArgs) =>
        query(
          `INSERT INTO drill_submissions
        (id,athlete_id,sport,drill_type,form_score,frames_analyzed,flaw_flags,joint_angles_summary,signature_hash,signature_version,metadata_verified)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) RETURNING id`,
          [
            randomUUID(),
            (data as Prisma.DrillSubmissionUncheckedCreateInput).athleteId,
            data.sport,
            data.drillType,
            data.formScore,
            data.framesAnalyzed,
            JSON.stringify(data.flawFlags),
            JSON.stringify(data.jointAnglesSummary),
            data.signatureHash,
            data.signatureVersion,
            data.metadataVerified,
          ],
        ),
    },
    wearableSession: countRows('wearable_sessions'),
    healthAlert: countRows('health_alerts'),
    verifiedMatchResult: {
      count: async ({ where }: Prisma.VerifiedMatchResultCountArgs) => {
        const userId = (where!.participantAthleteIds as Prisma.StringNullableListFilter).has;
        const sport = (where!.bracket as { tournament?: { sport?: string } } | undefined)
          ?.tournament?.sport;
        return (
          await query<{ count: number }>(
            `SELECT count(*)::int AS count FROM verified_match_results v
          JOIN brackets b ON b.id=v.bracket_id JOIN tournaments t ON t.id=b.tournament_id
          WHERE $1::uuid=ANY(v.participant_athlete_ids) ${sport ? 'AND t.sport=$2::"SportType"' : ''}`,
            sport ? [userId, sport] : [userId],
          )
        ).rows[0]!.count;
      },
    },
    sportPassportRecord: {
      findMany: async ({ where }: Prisma.SportPassportRecordFindManyArgs) =>
        (
          await query(
            `SELECT * FROM sport_passport_records WHERE athlete_id=$1 ${where!.sport ? 'AND sport=$2::"SportType"' : ''}`,
            where!.sport ? [where!.athleteId, where!.sport] : [where!.athleteId],
          )
        ).rows.map(camel),
      count: async ({ where }: Prisma.SportPassportRecordCountArgs) =>
        (
          await query<{ count: number }>(
            'SELECT count(*)::int AS count FROM sport_passport_records WHERE athlete_id=$1 AND total_matches>0',
            [where!.athleteId],
          )
        ).rows[0]!.count,
    },
    gtiHistory: {
      findFirst: async ({ where }: Prisma.GtiHistoryFindFirstArgs) =>
        (
          await query(
            'SELECT calculation_factors AS "calculationFactors" FROM gti_histories WHERE athlete_id=$1 AND calculation_factors->>\'deliveryId\'=$2 LIMIT 1',
            [where!.athleteId, (where!.calculationFactors as Prisma.JsonFilter).equals],
          )
        ).rows[0] ?? null,
      create: async ({ data }: Prisma.GtiHistoryCreateArgs) =>
        query(
          `INSERT INTO gti_histories
        (id,athlete_id,biomechanical_score,wearable_score,match_score,composite_gti,calculation_factors)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
          [
            randomUUID(),
            (data as Prisma.GtiHistoryUncheckedCreateInput).athleteId,
            Number(data.biomechanicalScore),
            Number(data.wearableScore),
            Number(data.matchScore),
            Number(data.compositeGti),
            JSON.stringify(data.calculationFactors),
          ],
        ),
    },
  };
  if (withOutbox)
    Object.assign(adapter, {
      outboxEvent: {
        updateMany: async ({ where, data }: Prisma.OutboxEventUpdateManyArgs) => {
          const params: unknown[] = [where!.id];
          const columns: Record<string, string> = {
            lockedBy: 'locked_by',
            lockedUntil: 'locked_until',
            deliveredAt: 'delivered_at',
            lastError: 'last_error',
            attempts: 'attempts',
            availableAt: 'available_at',
          };
          const assignments = Object.entries(data).map(([key, value]) => {
            if (key === 'attempts') return 'attempts=attempts+1';
            if (!columns[key]) throw new Error(`Unsupported outbox update: ${key}`);
            params.push(value);
            return `${columns[key]}=$${params.length}`;
          });
          let condition = 'id=$1';
          if (where!.lockedBy) {
            params.push(where!.lockedBy);
            condition += ` AND locked_by=$${params.length}`;
          }
          if (where!.deliveredAt === null) condition += ' AND delivered_at IS NULL';
          if (where!.OR) condition += ' AND (locked_until IS NULL OR locked_until<now())';
          const result = await query(
            `UPDATE outbox_events SET ${assignments.join(',')} WHERE ${condition}`,
            params,
          );
          return { count: result.affectedRows ?? 0 };
        },
      },
    });
  return {
    db,
    prisma: adapter as unknown as PrismaService,
    seedAthlete: async (verified = false) => {
      const userId = randomUUID(),
        profileId = randomUUID();
      await db.query("INSERT INTO users(id,role,updated_at) VALUES($1,'ATHLETE',now())", [userId]);
      if (verified)
        await db.query(
          "INSERT INTO identity_verifications(id,user_id,id_hash,id_type,status) VALUES($1,$2,$3,'AADHAAR','VERIFIED')",
          [randomUUID(), userId, userId.replaceAll('-', '').padEnd(64, 'a')],
        );
      await db.query(
        "INSERT INTO athlete_profiles(id,user_id,primary_sport,district,state,updated_at) VALUES($1,$2,'CRICKET','Pune','Maharashtra',now())",
        [profileId, userId],
      );
      return { userId, profileId };
    },
  };
}
