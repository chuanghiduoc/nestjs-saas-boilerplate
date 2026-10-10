import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js';
import { ORG_PURGE_STATEMENTS } from '../../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import {
  QUOTA_TZ,
  readCounters,
  seedFeatures,
  seedOrgEntitlement,
  seedPlans,
  withOwner,
} from '../../support/entitlements-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Lỗi pg có `code` (SQLSTATE) và `constraint`; đọc bằng `Reflect.get` để không cast. */
async function rejectsWith(
  p: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected a database error').toBeInstanceOf(Error);
  if (!(err instanceof Error)) return;
  expect(Reflect.get(err, 'code')).toBe(code);
  if (constraint) expect(Reflect.get(err, 'constraint')).toBe(constraint);
}
const inOrg = (orgId: string, sql: string, params: unknown[] = []) =>
  withAppClient((c) => inOrgTx(c, orgId, () => c.query(sql, params)));
const owner = (sql: string, params: unknown[] = []) =>
  withOwner((c) => c.query(sql, params));
const MONTH = `date_trunc('month', now(), '${QUOTA_TZ}')`;
/** Chèn bằng `app_user` trong OrgScope của org (đường của app). */
const insertCounter = (
  orgId: string,
  featureKey: string,
  period: string,
  used = '0',
  version = '1',
) =>
  inOrg(
    orgId,
    `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
     SELECT app_current_org(), id, ${period}, ${used}, ${version} FROM entitlement_features WHERE key = $1`,
    [featureKey],
  );
/** Câu consume của spec §9.2 (kỳ NONE) viết bằng tham số pg: hồi quy SQL của S4-T2 trên bảng thật. */
const consumeNone = (
  orgId: string,
  featureKey: string,
  n: number,
  max: number,
) =>
  inOrg(
    orgId,
    `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
     SELECT app_current_org(), id, NULL, $2, 1 FROM entitlement_features WHERE key = $1
     ON CONFLICT (org_id, feature_id, period_start)
     DO UPDATE SET used = usage_counters.used + EXCLUDED.used, version = usage_counters.version + 1, updated_at = clock_timestamp()
     WHERE usage_counters.used + EXCLUDED.used <= $3
     RETURNING used::text AS used, version::text AS version`,
    [featureKey, n, max],
  );

describe('usage_counters schema (spec SP4 §7.5, DB-1, DB-2, DB-3, R-1)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let bare: SeededOrg;
  const disposers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    disposers.push(
      await seedFeatures([
        {
          key: 'ucdb.month',
          kind: 'QUOTA',
          resetPeriod: 'MONTH',
          deprecated: false,
        },
        {
          key: 'ucdb.none',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          deprecated: false,
        },
        {
          key: 'ucdb.cap',
          kind: 'LIMIT',
          resetPeriod: null,
          deprecated: false,
        },
        {
          key: 'ucdb.old',
          kind: 'QUOTA',
          resetPeriod: 'MONTH',
          deprecated: true,
        },
      ]),
    );
    disposers.push(await seedPlans([{ key: 'ucdb_plan' }]));
    a = await seedOrg();
    b = await seedOrg();
    bare = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'ucdb_plan');
    await seedOrgEntitlement(b.orgId, 'ucdb_plan');
  });
  afterAll(async () => {
    for (const o of [a, b, bare]) await o?.dispose();
    for (const d of disposers.reverse()) await d();
  });

  it('DB-1: RLS + FORCE; app_user has SELECT/INSERT/DELETE and UPDATE only on used, version, updated_at', async () => {
    const { rows } = await owner(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              has_table_privilege('app_user', c.oid, 'SELECT') AS sel, has_table_privilege('app_user', c.oid, 'INSERT') AS ins,
              has_table_privilege('app_user', c.oid, 'DELETE') AS del, has_table_privilege('app_user', c.oid, 'TRUNCATE') AS trunc
       FROM pg_class c WHERE c.oid = 'public.usage_counters'::regclass`,
    );
    expect(rows).toEqual([
      { rls: true, force: true, sel: true, ins: true, del: true, trunc: false },
    ]);
    const cols = await owner(
      `SELECT a.attname AS col FROM pg_attribute a
       WHERE a.attrelid = 'public.usage_counters'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('app_user', a.attrelid, a.attname, 'UPDATE') ORDER BY a.attname`,
    );
    expect(cols.rows.map((r) => r.col)).toEqual([
      'updated_at',
      'used',
      'version',
    ]);
  });
  it('the period trigger function is INVOKER, owned by app_owner, not executable by PUBLIC or app_user', async () => {
    const { rows } = await owner(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec,
              p.proconfig AS config
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'entitlements_usage_counter_period_ck'`,
    );
    expect(rows).toEqual([
      {
        owner: 'app_owner',
        definer: false,
        app_user_exec: false,
        public_exec: false,
        config: ['search_path=pg_catalog, public'],
      },
    ]);
  });
  it('the arbiter is UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)', async () => {
    const { rows } = await owner(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'usage_counters_period_uq'`,
    );
    expect(rows).toEqual([
      { def: 'UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)' },
    ]);
  });
  it('files.storage_bytes is seeded as a LIMIT without a reset period (spec §8.1)', async () => {
    const { rows } = await owner(
      `SELECT kind, reset_period, deprecated_at FROM entitlement_features WHERE key = 'files.storage_bytes'`,
    );
    expect(rows).toEqual([
      { kind: 'LIMIT', reset_period: null, deprecated_at: null },
    ]);
  });

  it.each([
    [
      'a counter of a LIMIT feature',
      'ucdb.cap',
      'NULL',
      '0',
      '1',
      'usage_counters_period_ck',
    ],
    [
      'a NONE counter with a period',
      'ucdb.none',
      MONTH,
      '0',
      '1',
      'usage_counters_period_ck',
    ],
    [
      'a MONTH counter without a period',
      'ucdb.month',
      'NULL',
      '0',
      '1',
      'usage_counters_period_ck',
    ],
    [
      'a counter of a deprecated feature',
      'ucdb.old',
      MONTH,
      '0',
      '1',
      'usage_counters_period_ck',
    ],
    ['used = -1', 'ucdb.none', 'NULL', '-1', '1', 'usage_counters_used_ck'],
    [
      'used = 2^53',
      'ucdb.none',
      'NULL',
      '9007199254740992',
      '1',
      'usage_counters_used_ck',
    ],
    [
      'version = -1',
      'ucdb.none',
      'NULL',
      '0',
      '-1',
      'usage_counters_version_ck',
    ],
  ])(
    'DB-3: INSERT with %s → 23514 %s',
    async (_, key, period, used, version, constraint) => {
      await rejectsWith(
        insertCounter(a.orgId, key, period, used, version),
        '23514',
        constraint,
      );
    },
  );
  it('DB-3: a second NONE row of the same org and feature → 23505 usage_counters_period_uq (NULLS NOT DISTINCT)', async () => {
    await insertCounter(b.orgId, 'ucdb.none', 'NULL');
    await rejectsWith(
      insertCounter(b.orgId, 'ucdb.none', 'NULL'),
      '23505',
      'usage_counters_period_uq',
    );
    await inOrg(b.orgId, 'DELETE FROM usage_counters');
  });
  it('DB-3: a counter for an org without an org_entitlements row → 23503 usage_counters_org_fk', async () => {
    await rejectsWith(
      insertCounter(bare.orgId, 'ucdb.none', 'NULL'),
      '23503',
      'usage_counters_org_fk',
    );
  });
  it('DB-3: an unknown feature id → 23503 usage_counters_feature_fk (the trigger leaves a missing feature to the FK)', async () => {
    await rejectsWith(
      inOrg(
        a.orgId,
        `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version) VALUES (app_current_org(), -1, NULL, 0, 1)`,
      ),
      '23503',
      'usage_counters_feature_fk',
    );
  });
  it('DB-3: a feature still referenced by a counter cannot be deleted (FK RESTRICT → 23001)', async () => {
    await insertCounter(a.orgId, 'ucdb.none', 'NULL');
    try {
      await rejectsWith(
        owner(`DELETE FROM entitlement_features WHERE key = 'ucdb.none'`),
        '23001',
        'usage_counters_feature_fk',
      );
    } finally {
      await inOrg(a.orgId, 'DELETE FROM usage_counters');
    }
  });
  it.each(['org_id', 'feature_id', 'period_start', 'created_at'])(
    'DB-1: app_user cannot UPDATE %s (column grant → 42501)',
    async (col) => {
      await insertCounter(a.orgId, 'ucdb.none', 'NULL');
      try {
        await rejectsWith(
          inOrg(a.orgId, `UPDATE usage_counters SET ${col} = ${col}`),
          '42501',
        );
      } finally {
        await inOrg(a.orgId, 'DELETE FROM usage_counters');
      }
    },
  );
  it('S4-T2 regression on the real table (QU-2, sequential): NULL period 3 → 5 → refused, one row, version 2', async () => {
    const r1 = await consumeNone(a.orgId, 'ucdb.none', 3, 5);
    const r2 = await consumeNone(a.orgId, 'ucdb.none', 2, 5);
    const r3 = await consumeNone(a.orgId, 'ucdb.none', 1, 5);
    expect([r1.rows, r2.rows, r3.rowCount]).toEqual([
      [{ used: '3', version: '1' }],
      [{ used: '5', version: '2' }],
      0,
    ]);
    expect(
      (await readCounters(a.orgId)).map((r) => [
        r.feature,
        r.periodStart,
        r.used,
        r.version,
      ]),
    ).toEqual([['ucdb.none', null, 5, 2]]);
    await inOrg(a.orgId, 'DELETE FROM usage_counters');
  });

  describe('DB-2 isolation (criterion 8)', () => {
    beforeAll(async () => {
      await insertCounter(b.orgId, 'ucdb.month', MONTH, '7');
    });
    afterAll(async () => {
      await inOrg(b.orgId, 'DELETE FROM usage_counters');
    });
    it('read/update/delete of org B from OrgScope(A) touch 0 rows and leave B unchanged', async () => {
      const before = await readCounters(b.orgId);
      expect(
        (
          await inOrg(
            a.orgId,
            'SELECT 1 FROM usage_counters WHERE org_id = $1',
            [b.orgId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inOrg(
            a.orgId,
            'UPDATE usage_counters SET used = used + 1 WHERE org_id = $1',
            [b.orgId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inOrg(a.orgId, 'DELETE FROM usage_counters WHERE org_id = $1', [
            b.orgId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(await readCounters(b.orgId)).toEqual(before);
    });
    it('INSERT with org_id = B from OrgScope(A) is refused by RLS (42501)', async () => {
      await rejectsWith(
        inOrg(
          a.orgId,
          `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
           SELECT $1, id, NULL, 0, 1 FROM entitlement_features WHERE key = 'ucdb.none'`,
          [b.orgId],
        ),
        '42501',
      );
    });
    it('without an org context the table fails closed (P0001)', async () => {
      await rejectsWith(
        withAppClient((c) => c.query('SELECT 1 FROM usage_counters')),
        'P0001',
      );
    });
  });

  it('R-1: a purge without the entitlements statements fails loud; the 4A statement alone fails on the counters; all statements remove everything', async () => {
    const c = await seedOrg();
    await seedOrgEntitlement(c.orgId, 'ucdb_plan');
    await insertCounter(c.orgId, 'ucdb.none', 'NULL', '2');
    await insertCounter(c.orgId, 'ucdb.month', MONTH, '1');
    const purge = (statements: readonly string[]) =>
      withAppClient((cl) =>
        inOrgTx(cl, c.orgId, async () => {
          await cl.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org()`,
          );
          for (const sql of statements) await cl.query(sql);
        }),
      );
    await rejectsWith(
      purge(ORG_PURGE_STATEMENTS),
      '23001',
      'org_entitlements_org_fk',
    );
    await rejectsWith(
      purge([
        'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
        ...ORG_PURGE_STATEMENTS,
      ]),
      '23001',
      'usage_counters_org_fk',
    );
    expect(await readCounters(c.orgId)).toHaveLength(2);
    await purge([...ENTITLEMENTS_PURGE_STATEMENTS, ...ORG_PURGE_STATEMENTS]);
    expect(await readCounters(c.orgId)).toEqual([]);
    await c.dispose();
  });
});
