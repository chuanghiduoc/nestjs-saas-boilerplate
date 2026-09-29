import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FEATURE_KEY_PATTERN,
  PLAN_KEY_PATTERN,
} from '../../../src/modules/entitlements/constants.js';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js';
import { ORG_PURGE_STATEMENTS } from '../../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import {
  readOrgEntitlement,
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

/** Lỗi pg có `code` (SQLSTATE) và `constraint`; test đọc bằng `Reflect.get` để không cast. */
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
/** Một câu trong OrgScope của org (transaction riêng, rollback khi lỗi). */
const inOrg = (orgId: string, sql: string, params: unknown[] = []) =>
  withAppClient((c) => inOrgTx(c, orgId, () => c.query(sql, params)));
const owner = (sql: string, params: unknown[] = []) =>
  withOwner((c) => c.query(sql, params));
/** Câu của owner trong một transaction luôn rollback: kiểm "được phép" mà không đổi DB dùng chung. */
const ownerProbe = (sql: string) =>
  withOwner(async (c) => {
    await c.query('BEGIN');
    try {
      return await c.query(sql);
    } finally {
      await c.query('ROLLBACK');
    }
  });
const insertFor = (
  orgId: string,
  cols: string,
  values: string,
  params: unknown[] = [],
) =>
  inOrg(
    orgId,
    `INSERT INTO org_entitlements (org_id, plan_id, plan_assigned_at, ${cols}) SELECT app_current_org(), id, now(), ${values} FROM plans WHERE key = 'sch_basic'`,
    params,
  );

describe('entitlements schema invariants (spec SP4 §7.1–7.3, DB-3)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  const disposers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    disposers.push(
      await seedPlans([
        { key: 'sch_basic' },
        { key: 'sch_other' },
        { key: 'sch_old', retired: true },
      ]),
    );
    a = await seedOrg();
    b = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'sch_basic', {
      source: 'BILLING',
      sourceRef: 'sub_1',
      lastBillingSeq: 5n,
    });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    for (const d of disposers.reverse()) await d();
  });

  it('the four trigger functions are INVOKER, owned by app_owner, and not executable by PUBLIC or app_user (as SP2/3A)', async () => {
    const fns = [
      'entitlements_billing_seq_monotonic',
      'entitlements_feature_immutable',
      'entitlements_plan_key_immutable',
      'entitlements_plan_not_retired',
    ];
    const { rows } = await owner(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[]) ORDER BY p.proname`,
      [fns],
    );
    expect(rows).toEqual(
      fns.map((proname) => ({
        proname,
        owner: 'app_owner',
        definer: false,
        app_user_exec: false,
        public_exec: false,
      })),
    );
  });

  describe('entitlement_features', () => {
    it('the key CHECK is the FEATURE_KEY_PATTERN of the code; plans_key_ck is PLAN_KEY_PATTERN', async () => {
      const defs = await owner(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('entitlement_features_key_ck', 'plans_key_ck') ORDER BY conname`,
      );
      expect(defs.rows[0]?.def).toContain(FEATURE_KEY_PATTERN.source);
      expect(defs.rows[1]?.def).toContain(PLAN_KEY_PATTERN.source);
    });
    it.each([
      [`('Bad.key', 'FLAG', NULL)`, 'entitlement_features_key_ck'],
      [`('x.y', 'COUNTER', NULL)`, 'entitlement_features_kind_ck'],
      [`('x.y', 'FLAG', 'MONTH')`, 'entitlement_features_period_ck'],
      [`('x.y', 'QUOTA', NULL)`, 'entitlement_features_period_ck'],
      [`('x.y', 'QUOTA', 'DAY')`, 'entitlement_features_reset_period_ck'],
    ])('INSERT %s → 23514 %s', async (values, constraint) => {
      await rejectsWith(
        owner(
          `INSERT INTO entitlement_features (key, kind, reset_period) VALUES ${values}`,
        ),
        '23514',
        constraint,
      );
    });
    it.each([
      `key = 'tenancy.members'`,
      `kind = 'FLAG'`,
      `reset_period = 'NONE', kind = 'QUOTA'`,
    ])(
      'UPDATE %s of a feature → 23514 entitlement_features_immutable (a new key is the only way)',
      async (set) => {
        await rejectsWith(
          owner(
            `UPDATE entitlement_features SET ${set} WHERE key = 'tenancy.seats'`,
          ),
          '23514',
          'entitlement_features_immutable',
        );
      },
    );
    it('deprecating a feature is allowed', async () => {
      expect(
        (
          await ownerProbe(
            `UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'tenancy.seats'`,
          )
        ).rowCount,
      ).toBe(1);
    });
    it('the boilerplate feature tenancy.seats is seeded as a LIMIT', async () => {
      expect(
        (
          await owner(
            `SELECT kind, reset_period, deprecated_at FROM entitlement_features WHERE key = 'tenancy.seats'`,
          )
        ).rows,
      ).toEqual([{ kind: 'LIMIT', reset_period: null, deprecated_at: null }]);
    });
    it('entitlements.read is seeded: API-key and support eligible, not owner-only, requiring org.read (spec SP4 S4-D17)', async () => {
      const { rows } = await owner(
        `SELECT p.owner_only, p.api_key_eligible, p.support_eligible, array_agg(q.key ORDER BY q.key) AS requires
         FROM permissions p JOIN permission_requires r ON r.permission_id = p.id JOIN permissions q ON q.id = r.required_permission_id
         WHERE p.key = 'entitlements.read' GROUP BY p.id`,
      );
      expect(rows).toEqual([
        {
          owner_only: false,
          api_key_eligible: true,
          support_eligible: true,
          requires: ['org.read'],
        },
      ]);
    });
  });

  describe('plans', () => {
    it('bad key → plans_key_ck; renaming a plan → plans_key_immutable; retiring is allowed', async () => {
      await rejectsWith(
        owner(`INSERT INTO plans (key) VALUES ('Pro')`),
        '23514',
        'plans_key_ck',
      );
      await rejectsWith(
        owner(`UPDATE plans SET key = 'sch_renamed' WHERE key = 'sch_other'`),
        '23514',
        'plans_key_immutable',
      );
      expect(
        (
          await ownerProbe(
            `UPDATE plans SET retired_at = now() WHERE key = 'sch_other'`,
          )
        ).rowCount,
      ).toBe(1);
    });
    it('a plan still referenced by an organization cannot be deleted (FK RESTRICT → 23001)', async () => {
      await rejectsWith(
        owner(`DELETE FROM plans WHERE key = 'sch_basic'`),
        '23001',
        'org_entitlements_plan_fk',
      );
    });
    it('app_user cannot write the lookup tables (42501)', async () => {
      await rejectsWith(
        inOrg(b.orgId, `INSERT INTO plans (key) VALUES ('sch_nope')`),
        '42501',
      );
      await rejectsWith(
        inOrg(
          b.orgId,
          `INSERT INTO entitlement_features (key, kind) VALUES ('x.nope', 'FLAG')`,
        ),
        '42501',
      );
    });
  });

  describe('org_entitlements', () => {
    it.each([
      [
        'BILLING without a ref',
        `plan_source`,
        `'BILLING'`,
        'org_entitlements_source_ref_ck',
      ],
      [
        'DEFAULT with a ref',
        `plan_source, plan_source_ref`,
        `'DEFAULT', 'sub_x'`,
        'org_entitlements_source_ref_ck',
      ],
      [
        'PLATFORM_ADMIN without a reason',
        `plan_source`,
        `'PLATFORM_ADMIN'`,
        'org_entitlements_reason_ck',
      ],
      [
        'a reason with outer spaces',
        `plan_source, plan_reason`,
        `'PLATFORM_ADMIN', ' padded '`,
        'org_entitlements_reason_format_ck',
      ],
      [
        'a 501-character reason',
        `plan_source, plan_reason`,
        `'PLATFORM_ADMIN', repeat('r', 501)`,
        'org_entitlements_reason_format_ck',
      ],
      [
        'a 129-character ref',
        `plan_source, plan_source_ref`,
        `'BILLING', repeat('s', 129)`,
        'org_entitlements_source_ref_length_ck',
      ],
      [
        'an unknown source',
        `plan_source`,
        `'MANUAL'`,
        'org_entitlements_source_ck',
      ],
      [
        'last_billing_seq 0',
        `plan_source, plan_source_ref, last_billing_seq`,
        `'BILLING', 'sub_x', 0`,
        'org_entitlements_billing_seq_ck',
      ],
      [
        'version 0',
        `plan_source, version`,
        `'DEFAULT', 0`,
        'org_entitlements_version_ck',
      ],
    ])('INSERT with %s → 23514 %s', async (_, cols, values, constraint) => {
      await rejectsWith(insertFor(b.orgId, cols, values), '23514', constraint);
    });
    it('a new row on a retired plan → org_entitlements_plan_not_retired', async () => {
      await rejectsWith(
        inOrg(
          b.orgId,
          `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT app_current_org(), id, 'DEFAULT', now() FROM plans WHERE key = 'sch_old'`,
        ),
        '23514',
        'org_entitlements_plan_not_retired',
      );
    });
    it('a row for an organization that does not exist → 23503 org_entitlements_org_fk', async () => {
      const ghost = v7();
      await rejectsWith(
        inOrg(
          ghost,
          `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT app_current_org(), id, 'DEFAULT', now() FROM plans WHERE key = 'sch_basic'`,
        ),
        '23503',
        'org_entitlements_org_fk',
      );
    });
    it('last_billing_seq never goes back or to NULL; the same value in SET (a staff APPLIED) and a raise are allowed (K-1)', async () => {
      await rejectsWith(
        inOrg(a.orgId, `UPDATE org_entitlements SET last_billing_seq = 4`),
        '23514',
        'org_entitlements_billing_seq_monotonic',
      );
      await rejectsWith(
        inOrg(a.orgId, `UPDATE org_entitlements SET last_billing_seq = NULL`),
        '23514',
        'org_entitlements_billing_seq_monotonic',
      );
      await inOrg(
        a.orgId,
        `UPDATE org_entitlements SET last_billing_seq = COALESCE(NULL, last_billing_seq), version = version + 1`,
      );
      await inOrg(a.orgId, `UPDATE org_entitlements SET last_billing_seq = 6`);
      expect((await readOrgEntitlement(a.orgId))?.lastBillingSeq).toBe('6');
    });
    it('moving to a retired plan is refused; an org already on a plan that becomes retired keeps it', async () => {
      await rejectsWith(
        inOrg(
          a.orgId,
          `UPDATE org_entitlements SET plan_id = (SELECT id FROM plans WHERE key = 'sch_old')`,
        ),
        '23514',
        'org_entitlements_plan_not_retired',
      );
      await owner(
        `UPDATE plans SET retired_at = now() WHERE key = 'sch_basic'`,
      );
      try {
        await inOrg(
          a.orgId,
          `UPDATE org_entitlements SET plan_id = plan_id, version = version + 1, updated_at = now()`,
        );
        expect((await readOrgEntitlement(a.orgId))?.planKey).toBe('sch_basic');
      } finally {
        await owner(
          `UPDATE plans SET retired_at = NULL WHERE key = 'sch_basic'`,
        );
      }
    });
    it('org_id is not updatable by app_user (column grant)', async () => {
      await rejectsWith(
        inOrg(a.orgId, `UPDATE org_entitlements SET org_id = org_id`),
        '42501',
      );
    });
    it('a purge that forgets the entitlements participant fails loud (23001); with it the org is gone', async () => {
      const c = await seedOrg();
      await seedOrgEntitlement(c.orgId, 'sch_other');
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
      await purge([...ENTITLEMENTS_PURGE_STATEMENTS, ...ORG_PURGE_STATEMENTS]);
      expect(await readOrgEntitlement(c.orgId)).toBeUndefined();
      await c.dispose();
    });
  });
});
