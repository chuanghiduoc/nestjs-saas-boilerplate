import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_VALUE_MAX,
  REASON_MAX_LENGTH,
} from '../../../src/modules/entitlements/constants.js';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js';
import { ORG_PURGE_STATEMENTS } from '../../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import {
  readOverrides,
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
/** Chèn bằng `app_user` trong OrgScope (đường của app); `cols` là cột tuỳ chọn ngoài khoá, giá trị là SQL. */
const insertOverride = (
  orgId: string,
  featureKey: string,
  cols: {
    flag?: string;
    limit?: string;
    reason?: string;
    expires?: string;
    updated?: string;
  } = {},
) =>
  inOrg(
    orgId,
    `INSERT INTO org_entitlement_overrides (org_id, feature_id, flag_value, limit_value, reason, expires_at, updated_at)
     SELECT app_current_org(), id, ${cols.flag ?? 'NULL'}, ${cols.limit ?? 'NULL'}, ${cols.reason ?? `'why'`},
            ${cols.expires ?? 'NULL'}, ${cols.updated ?? 'now()'}
     FROM entitlement_features WHERE key = $1`,
    [featureKey],
  );
const clear = (orgId: string) =>
  inOrg(orgId, 'DELETE FROM org_entitlement_overrides');

describe('org_entitlement_overrides schema (spec SP4 §7.4, DB-1, DB-2, DB-3, R-1)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let bare: SeededOrg;
  const disposers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    disposers.push(
      await seedFeatures([
        {
          key: 'ovdb.flag',
          kind: 'FLAG',
          resetPeriod: null,
          deprecated: false,
        },
        {
          key: 'ovdb.cap',
          kind: 'LIMIT',
          resetPeriod: null,
          deprecated: false,
        },
        {
          key: 'ovdb.calls',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          deprecated: false,
        },
        { key: 'ovdb.old', kind: 'FLAG', resetPeriod: null, deprecated: true },
      ]),
    );
    disposers.push(await seedPlans([{ key: 'ovdb_plan' }]));
    a = await seedOrg();
    b = await seedOrg();
    bare = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'ovdb_plan');
    await seedOrgEntitlement(b.orgId, 'ovdb_plan');
  });
  afterAll(async () => {
    for (const o of [a, b, bare]) await o?.dispose();
    for (const d of disposers.reverse()) await d();
  });

  it('DB-1: RLS + FORCE; app_user has SELECT/INSERT/DELETE, no TRUNCATE, and UPDATE only on the five value columns', async () => {
    const { rows } = await owner(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              has_table_privilege('app_user', c.oid, 'SELECT') AS sel, has_table_privilege('app_user', c.oid, 'INSERT') AS ins,
              has_table_privilege('app_user', c.oid, 'DELETE') AS del, has_table_privilege('app_user', c.oid, 'TRUNCATE') AS trunc
       FROM pg_class c WHERE c.oid = 'public.org_entitlement_overrides'::regclass`,
    );
    expect(rows).toEqual([
      { rls: true, force: true, sel: true, ins: true, del: true, trunc: false },
    ]);
    const cols = await owner(
      `SELECT a.attname AS col FROM pg_attribute a
       WHERE a.attrelid = 'public.org_entitlement_overrides'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('app_user', a.attrelid, a.attname, 'UPDATE') ORDER BY a.attname`,
    );
    expect(cols.rows.map((r) => r.col)).toEqual([
      'expires_at',
      'flag_value',
      'limit_value',
      'reason',
      'updated_at',
    ]);
  });
  it('the value trigger function is INVOKER, owned by app_owner, not executable by PUBLIC or app_user', async () => {
    const { rows } = await owner(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec,
              p.proconfig AS config
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'entitlements_override_value_ck'`,
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
    const trig = await owner(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.org_entitlement_overrides'::regclass`,
    );
    expect(trig.rows).toEqual([
      { tgname: 'org_entitlement_overrides_value_ck' },
    ]);
  });
  it('the CHECKs carry the constants of the code (ENTITLEMENT_VALUE_MAX, REASON_MAX_LENGTH); the feature FK has its index', async () => {
    const { rows } = await owner(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.org_entitlement_overrides'::regclass AND contype = 'c' ORDER BY conname`,
    );
    const def = (name: string) =>
      rows.find((r) => r.conname === name)?.def ?? '';
    expect(rows.map((r) => r.conname)).toEqual([
      'org_entitlement_overrides_expiry_ck',
      'org_entitlement_overrides_limit_ck',
      'org_entitlement_overrides_one_value_ck',
      'org_entitlement_overrides_reason_ck',
    ]);
    expect(def('org_entitlement_overrides_limit_ck')).toContain(
      String(ENTITLEMENT_VALUE_MAX),
    );
    expect(def('org_entitlement_overrides_reason_ck')).toContain(
      String(REASON_MAX_LENGTH),
    );
    const idx = await owner(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'org_entitlement_overrides_feature_idx'`,
    );
    expect(idx.rows).toEqual([
      {
        indexdef:
          'CREATE INDEX org_entitlement_overrides_feature_idx ON public.org_entitlement_overrides USING btree (feature_id)',
      },
    ]);
  });

  it.each([
    [
      'a FLAG override without a flag value',
      'ovdb.flag',
      {},
      'org_entitlement_overrides_value_ck',
    ],
    [
      'a FLAG override with a limit',
      'ovdb.flag',
      { flag: 'true', limit: '3' },
      'org_entitlement_overrides_value_ck',
    ],
    [
      'a LIMIT override with a flag value',
      'ovdb.cap',
      { flag: 'true' },
      'org_entitlement_overrides_value_ck',
    ],
    [
      'a QUOTA override with a flag value',
      'ovdb.calls',
      { flag: 'false' },
      'org_entitlement_overrides_value_ck',
    ],
    [
      'an override of a deprecated feature',
      'ovdb.old',
      { flag: 'true' },
      'org_entitlement_overrides_value_ck',
    ],
    [
      'limit = -1',
      'ovdb.cap',
      { limit: '-1' },
      'org_entitlement_overrides_limit_ck',
    ],
    [
      'limit = 2^53',
      'ovdb.cap',
      { limit: '9007199254740992' },
      'org_entitlement_overrides_limit_ck',
    ],
    [
      'an empty reason',
      'ovdb.cap',
      { limit: '1', reason: `''` },
      'org_entitlement_overrides_reason_ck',
    ],
    [
      'a reason with a leading space',
      'ovdb.cap',
      { limit: '1', reason: `' why'` },
      'org_entitlement_overrides_reason_ck',
    ],
    [
      'a reason of 501 characters',
      'ovdb.cap',
      { limit: '1', reason: `repeat('x', 501)` },
      'org_entitlement_overrides_reason_ck',
    ],
    [
      'an expiry not later than the write',
      'ovdb.cap',
      { limit: '1', expires: 'now()', updated: 'now()' },
      'org_entitlement_overrides_expiry_ck',
    ],
  ])('DB-3: INSERT %s → 23514 %s', async (_, key, cols, constraint) => {
    await rejectsWith(insertOverride(a.orgId, key, cols), '23514', constraint);
  });
  it('DB-3: valid rows — FLAG false, LIMIT NULL (unlimited), QUOTA 2^53 − 1, a 500-emoji reason, a future expiry', async () => {
    await insertOverride(a.orgId, 'ovdb.flag', { flag: 'false' });
    await insertOverride(a.orgId, 'ovdb.cap', {
      reason: `repeat('😀', ${REASON_MAX_LENGTH})`,
    });
    await insertOverride(a.orgId, 'ovdb.calls', {
      limit: String(ENTITLEMENT_VALUE_MAX),
      expires: `now() + interval '1 day'`,
    });
    expect(
      (await readOverrides(a.orgId)).map((r) => [
        r.feature,
        r.flagValue,
        r.limitValue,
      ]),
    ).toEqual([
      ['ovdb.calls', null, ENTITLEMENT_VALUE_MAX],
      ['ovdb.cap', null, null],
      ['ovdb.flag', false, null],
    ]);
    await clear(a.orgId);
  });
  it('DB-3: the trigger also guards UPDATE (S4C-1): turning a LIMIT override into a flag is refused', async () => {
    await insertOverride(a.orgId, 'ovdb.cap', { limit: '2' });
    try {
      await rejectsWith(
        inOrg(
          a.orgId,
          'UPDATE org_entitlement_overrides SET flag_value = true',
        ),
        '23514',
        'org_entitlement_overrides_value_ck',
      );
    } finally {
      await clear(a.orgId);
    }
  });
  it('DB-3: both values on an unknown feature id → 23514 one_value_ck (CHECK runs before the FK; the trigger leaves a missing feature to the FK)', async () => {
    await rejectsWith(
      inOrg(
        a.orgId,
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, flag_value, limit_value, reason) VALUES (app_current_org(), -1, true, 1, 'why')`,
      ),
      '23514',
      'org_entitlement_overrides_one_value_ck',
    );
  });
  it('DB-3: an unknown feature id → 23503 feature_fk; an org without an org_entitlements row → 23503 org_fk', async () => {
    await rejectsWith(
      inOrg(
        a.orgId,
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason) VALUES (app_current_org(), -1, 1, 'why')`,
      ),
      '23503',
      'org_entitlement_overrides_feature_fk',
    );
    await rejectsWith(
      insertOverride(bare.orgId, 'ovdb.cap', { limit: '1' }),
      '23503',
      'org_entitlement_overrides_org_fk',
    );
  });
  it('DB-3: a feature or a root row still referenced by an override cannot be deleted (FK RESTRICT → 23001)', async () => {
    await insertOverride(a.orgId, 'ovdb.cap', { limit: '1' });
    try {
      await rejectsWith(
        owner(`DELETE FROM entitlement_features WHERE key = 'ovdb.cap'`),
        '23001',
        'org_entitlement_overrides_feature_fk',
      );
      await rejectsWith(
        inOrg(
          a.orgId,
          'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
        ),
        '23001',
        'org_entitlement_overrides_org_fk',
      );
    } finally {
      await clear(a.orgId);
    }
  });
  it('DB-3 (DB-4 last line): the boilerplate feature files.storage_bytes cannot be deleted while an override references it (23001)', async () => {
    await insertOverride(a.orgId, 'files.storage_bytes', { limit: '10' });
    try {
      await rejectsWith(
        owner(
          `DELETE FROM entitlement_features WHERE key = 'files.storage_bytes'`,
        ),
        '23001',
        'org_entitlement_overrides_feature_fk',
      );
    } finally {
      await clear(a.orgId);
    }
  });
  it.each(['org_id', 'feature_id', 'created_at'])(
    'DB-1: app_user cannot UPDATE %s (column grant → 42501)',
    async (col) => {
      await insertOverride(a.orgId, 'ovdb.cap', { limit: '1' });
      try {
        await rejectsWith(
          inOrg(
            a.orgId,
            `UPDATE org_entitlement_overrides SET ${col} = ${col}`,
          ),
          '42501',
        );
      } finally {
        await clear(a.orgId);
      }
    },
  );

  describe('DB-2 isolation (criterion 8)', () => {
    beforeAll(async () => {
      await insertOverride(b.orgId, 'ovdb.cap', { limit: '7' });
    });
    afterAll(async () => {
      await clear(b.orgId);
    });
    it('read/update/delete of org B from OrgScope(A) touch 0 rows and leave B unchanged', async () => {
      const before = await readOverrides(b.orgId);
      for (const sql of [
        'SELECT 1 FROM org_entitlement_overrides WHERE org_id = $1',
        'UPDATE org_entitlement_overrides SET limit_value = 8 WHERE org_id = $1',
        'DELETE FROM org_entitlement_overrides WHERE org_id = $1',
      ])
        expect((await inOrg(a.orgId, sql, [b.orgId])).rowCount, sql).toBe(0);
      expect(await readOverrides(b.orgId)).toEqual(before);
    });
    it('INSERT with org_id = B from OrgScope(A) is refused by RLS (42501)', async () => {
      await rejectsWith(
        inOrg(
          a.orgId,
          `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason)
           SELECT $1, id, 1, 'why' FROM entitlement_features WHERE key = 'ovdb.cap'`,
          [b.orgId],
        ),
        '42501',
      );
    });
    it('without an org context the table fails closed (P0001)', async () => {
      await rejectsWith(
        withAppClient((c) =>
          c.query('SELECT 1 FROM org_entitlement_overrides'),
        ),
        'P0001',
      );
    });
  });

  it('R-1: a purge without the override statement fails loud (23001); all statements remove everything', async () => {
    const c = await seedOrg();
    await seedOrgEntitlement(c.orgId, 'ovdb_plan');
    await insertOverride(c.orgId, 'ovdb.cap', { limit: '2' });
    await insertOverride(c.orgId, 'ovdb.flag', { flag: 'true' });
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
      purge([
        'DELETE FROM usage_counters WHERE org_id = app_current_org()',
        'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
        ...ORG_PURGE_STATEMENTS,
      ]),
      '23001',
      'org_entitlement_overrides_org_fk',
    );
    expect(await readOverrides(c.orgId)).toHaveLength(2);
    expect(ENTITLEMENTS_PURGE_STATEMENTS).toEqual([
      'SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR UPDATE',
      'DELETE FROM usage_counters WHERE org_id = app_current_org()',
      'DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org()',
      'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
    ]);
    await purge([...ENTITLEMENTS_PURGE_STATEMENTS, ...ORG_PURGE_STATEMENTS]);
    expect(await readOverrides(c.orgId)).toEqual([]);
    await c.dispose();
  });
});
