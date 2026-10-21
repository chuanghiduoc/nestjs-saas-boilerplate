import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { AUDIT_TABLES } from '../../../src/modules/audit/constants.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  asPartitionOwner,
  insertPlatformAuditRow,
  monthTag,
  platformAuditRows,
} from '../../support/audit-seed.js';
import { getInfra } from '../../support/infra.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { withAppClient } from '../../support/tenancy-seed.js';

const appCall = (r: number | null, p: number | null, database?: string) =>
  withAppClient(
    (c) =>
      c.query<{ action: string; partition_name: string }>(
        'SELECT action, partition_name FROM public.audit_partitions_maintain($1, $2)',
        [r, p],
      ),
    database,
  ).then((x) => x.rows);

/** Catalog đọc bằng owner (pg_inherits, to_regclass): không phải bảng FORCE RLS. */
const catalogRows = async <T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const partitions = async (table: string) =>
  (
    await catalogRows<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass ORDER BY 1`,
      [`public.${table}`],
    )
  ).map((r) => r.name);
/** Gỡ partition tháng quá khứ nếu còn (không FK giữa hai bảng nên thứ tự không quan trọng). */
const detachPast = async (offset: number) => {
  for (const t of AUDIT_TABLES) {
    const name = `${t}_p${monthTag(offset).tag}`;
    const [row] = await catalogRows<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${name}`],
    );
    if (row?.present)
      await asPartitionOwner([
        `ALTER TABLE public.${t} DETACH PARTITION public.${name}`,
        `DROP TABLE public.${name}`,
      ]);
  }
};
const attachPast = async (offset: number) => {
  await detachPast(offset);
  const m = monthTag(offset);
  await asPartitionOwner(
    AUDIT_TABLES.flatMap((t) => [
      `CREATE TABLE public.${t}_p${m.tag} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      `ALTER TABLE public.${t} ATTACH PARTITION public.${t}_p${m.tag} FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
    ]),
  );
};

describe('audit_partitions_maintain (spec SP6 §6.7, A-10, R6-17)', () => {
  beforeAll(() => applyTestEnv());
  it.each([
    [5, 3],
    [121, 3],
    [13, 0],
    [13, 13],
  ])(
    'rejects retention %i / premake %i (floor and ceilings live in the function)',
    async (r, p) => {
      await expect(appCall(r, p)).rejects.toThrow(
        /p_(retention|premake)_months must be between/,
      );
    },
  );
  it('rejects NULL arguments', async () => {
    await expect(appCall(null, 3)).rejects.toThrow(/must not be NULL/);
  });
  it('premakes the current month and the next months for both tables, idempotently', async () => {
    await appCall(13, 4);
    for (const t of AUDIT_TABLES)
      for (const k of [0, 1, 2, 3, 4])
        expect(await partitions(t)).toContain(`${t}_p${monthTag(k).tag}`);
    expect(await appCall(13, 4)).toEqual([]);
  });
  it('drops exactly the partitions whose whole month is older than the retention: -7 goes, -6 stays (retention 6)', async () => {
    await attachPast(-7);
    await attachPast(-6);
    try {
      const out = await appCall(6, 3);
      expect(out).toEqual(
        expect.arrayContaining([
          {
            action: 'dropped',
            partition_name: `audit_logs_p${monthTag(-7).tag}`,
          },
          {
            action: 'dropped',
            partition_name: `platform_audit_logs_p${monthTag(-7).tag}`,
          },
        ]),
      );
      for (const t of AUDIT_TABLES) {
        expect(await partitions(t)).toContain(`${t}_p${monthTag(-6).tag}`);
        expect(await partitions(t)).not.toContain(`${t}_p${monthTag(-7).tag}`);
      }
    } finally {
      await detachPast(-7);
      await detachPast(-6);
    }
  });
  it('a partition with an unexpected name stops the run loudly', async () => {
    await asPartitionOwner([
      'CREATE TABLE public.audit_logs_rogue (LIKE public.audit_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
      `ALTER TABLE public.audit_logs ATTACH PARTITION public.audit_logs_rogue FOR VALUES FROM ('1990-01-01') TO ('1990-02-01')`,
    ]);
    try {
      await expect(appCall(13, 3)).rejects.toThrow(
        /unexpected partition audit_logs_rogue/,
      );
    } finally {
      await asPartitionOwner([
        'ALTER TABLE public.audit_logs DETACH PARTITION public.audit_logs_rogue',
        'DROP TABLE public.audit_logs_rogue',
      ]);
    }
  });
  it('R6-17: while one run holds the advisory lock, a second run returns no rows at once', async () => {
    await attachPast(-8);
    try {
      await withAppClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT pg_advisory_xact_lock(6001)');
          const started = Date.now();
          expect(await appCall(6, 6)).toEqual([]);
          expect(Date.now() - started).toBeLessThan(2_000);
        } finally {
          await holder.query('ROLLBACK');
        }
      });
      // Không vacuous: khi khoá đã nhả, cùng lượt đó có việc thật (drop tháng -8 của hai bảng).
      expect(
        (await appCall(6, 6)).filter((r) => r.action === 'dropped'),
      ).toEqual(
        AUDIT_TABLES.map((t) => ({
          action: 'dropped',
          partition_name: `${t}_p${monthTag(-8).tag}`,
        })),
      );
    } finally {
      await detachPast(-8);
    }
  });
});

describe('a missing current partition makes inserts fail loudly (A-11, spec §14)', () => {
  // Scratch DB: không bao giờ gỡ partition hiện hành của DB dùng chung (test khác đang ghi audit).
  let db: ScratchDb;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('sp6b_part');
    vi.stubEnv('DB_NAME', db.name);
    await runMigrations('up', {
      source: { kind: 'list', list: coreMigrationList() },
    });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });
  it('after detaching the current month an insert is 23514 and writes nothing; maintain restores it', async () => {
    const tag = monthTag(0).tag;
    await asPartitionOwner(
      [
        `ALTER TABLE public.platform_audit_logs DETACH PARTITION public.platform_audit_logs_p${tag}`,
        `DROP TABLE public.platform_audit_logs_p${tag}`,
      ],
      db.name,
    );
    await expect(
      withAppClient((c) => insertPlatformAuditRow(c), db.name),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await platformAuditRows({}, db.name)).toHaveLength(0);
    expect(await appCall(13, 3, db.name)).toContainEqual({
      action: 'created',
      partition_name: `platform_audit_logs_p${tag}`,
    });
    expect(await withAppClient((c) => insertPlatformAuditRow(c), db.name)).toBe(
      1,
    );
  });
  it('TRUNCATE of a single partition is the owner-only DETACH + DROP privilege, nothing more (statement triggers are not cloned)', async () => {
    const tag = monthTag(0).tag;
    expect(await withAppClient((c) => insertPlatformAuditRow(c), db.name)).toBe(
      1,
    );
    // app_user: không có quyền nào trên partition.
    await expect(
      withAppClient(
        (c) => c.query(`TRUNCATE public.platform_audit_logs_p${tag}`),
        db.name,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // owner: được, đúng bằng quyền DETACH + DROP vốn có.
    await asPartitionOwner(
      [`TRUNCATE public.platform_audit_logs_p${tag}`],
      db.name,
    );
    expect(await platformAuditRows({}, db.name)).toHaveLength(0);
  });
});
