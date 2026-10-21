import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFINER_LIMIT_MAX } from '../../../../src/core/sweep/index.js';
import {
  EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH as DMAX,
  EXAMPLE_PROJECT_NAME_MAX_LENGTH as NMAX,
} from '../../../../src/features/example/constants.js';
import { withOwner } from '../../../support/entitlements-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../../support/tenancy-seed.js';

const insertIn = (orgId: string, name: string, extra = '') =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(
        `INSERT INTO example_projects (org_id, name${extra ? ', status, status_changed_at' : ''})
               VALUES (app_current_org(), $1${extra}) RETURNING public_id::text`,
        [name],
      ),
    ),
  );
describe('example_projects schema, RLS and definer (spec §7, EX-I1..I3, I7, I8)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
  });
  afterAll(async () => {
    for (const o of [a, b])
      if (o)
        await withAppClient((c) =>
          inOrgTx(c, o.orgId, () => c.query('DELETE FROM example_projects')),
        );
    await a?.dispose();
    await b?.dispose();
  });

  it('EX-I1: app_user in OrgScope(A) sees, updates and deletes no row of org B', async () => {
    await insertIn(b.orgId, 'b-only');
    const r = await withAppClient((c) =>
      inOrgTx(c, a.orgId, async () => [
        (await c.query('SELECT 1 FROM example_projects')).rowCount,
        (await c.query(`UPDATE example_projects SET name = 'x'`)).rowCount,
        (await c.query('DELETE FROM example_projects')).rowCount,
      ]),
    );
    expect(r).toEqual([0, 0, 0]);
    // FORCE RLS: owner sees 0 rows, so the row of B is read back through app_user in OrgScope(B).
    const own = await withAppClient((c) =>
      inOrgTx(c, b.orgId, () => c.query('SELECT 1 FROM example_projects')),
    );
    expect(own.rowCount).toBe(1);
  });
  it('EX-I2: INSERT with org_id = B from OrgScope(A) → 42501', async () => {
    await expect(
      withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(
            `INSERT INTO example_projects (org_id, name) VALUES ($1, 'x')`,
            [b.orgId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('EX-I3: no org context → P0001', async () => {
    await expect(
      withAppClient((c) => c.query('SELECT 1 FROM example_projects')),
    ).rejects.toMatchObject({ code: 'P0001' });
  });
  it('CHECKs, unique lower(name), immutable identity columns', async () => {
    await insertIn(a.orgId, 'Website');
    await expect(insertIn(a.orgId, 'WEBSITE')).rejects.toMatchObject({
      code: '23505',
      constraint: 'example_projects_name_uq',
    });
    for (const [name, constraint] of [
      [' x', 'example_projects_name_ck'],
      ['', 'example_projects_name_ck'],
    ] as const)
      await expect(insertIn(a.orgId, name)).rejects.toMatchObject({
        code: '23514',
        constraint,
      });
    await expect(
      withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(`UPDATE example_projects SET org_id = $1`, [b.orgId]),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(`UPDATE example_projects SET created_at = now()`),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('EX-I7: CHECK definitions carry the code constants', async () => {
    const defs = await withOwner(async (c) =>
      Object.fromEntries(
        (
          await c.query<{ conname: string; def: string }>(
            `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conname IN ('example_projects_name_ck', 'example_projects_description_ck')`,
          )
        ).rows.map((r) => [r.conname, r.def]),
      ),
    );
    // pg_get_constraintdef viết lại BETWEEN thành `((char_length(name) >= 1) AND (char_length(name) <= 100))` (review code I1).
    expect(defs.example_projects_name_ck).toContain(
      `(char_length(name) <= ${NMAX})`,
    );
    expect(defs.example_projects_description_ck).toContain(
      `(char_length(description) <= ${DMAX})`,
    );
  });
  describe('EX-I8: example_orgs_with_purgeable_projects', () => {
    const call = (
      c: pg.Client,
      after: string | null,
      limit: number | null,
      retention: number | null,
    ) =>
      c.query<{ org_id: string }>(
        'SELECT org_id::text FROM public.example_orgs_with_purgeable_projects(p_after => $1::uuid, p_limit => $2::integer, p_retention_sec => $3::integer)',
        [after, limit, retention],
      );
    it('returns only orgs with due ARCHIVED rows, ascending; called like the SP6 runner it never raises (X2-2)', async () => {
      await insertIn(
        a.orgId,
        `due-${v7()}`,
        `, 'ARCHIVED', now() - interval '31 days'`,
      );
      await insertIn(
        b.orgId,
        `fresh-${v7()}`,
        `, 'ARCHIVED', now() - interval '1 day'`,
      );
      const rows = await withAppClient((c) =>
        call(
          c,
          '00000000-0000-0000-0000-000000000000',
          DEFINER_LIMIT_MAX,
          2_592_000,
        ),
      );
      expect(rows.rows.map((r) => r.org_id)).toContain(a.orgId);
      expect(rows.rows.map((r) => r.org_id)).not.toContain(b.orgId);
      const ids = rows.rows.map((r) => r.org_id);
      expect([...ids].sort()).toEqual(ids);
    });
    it.each([
      [null, 10, 3600],
      ['00000000-0000-0000-0000-000000000000', null, 3600],
      ['00000000-0000-0000-0000-000000000000', 10, null],
      ['00000000-0000-0000-0000-000000000000', 0, 3600],
      ['00000000-0000-0000-0000-000000000000', DEFINER_LIMIT_MAX + 1, 3600],
      ['00000000-0000-0000-0000-000000000000', 10, 0],
    ])('out-of-range (%s, %s, %s) → 22023', async (after, limit, retention) => {
      await expect(
        withAppClient((c) => call(c, after, limit, retention)),
      ).rejects.toMatchObject({ code: '22023' });
    });
    it('owned by sweep_definer, SECURITY DEFINER, search_path="", EXECUTE for app_user only; app_owner cannot DROP it', async () => {
      const row = await withOwner(
        async (c) =>
          (
            await c.query(
              `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig,
                  has_function_privilege('public', oid, 'EXECUTE') AS pub, has_function_privilege('app_user', oid, 'EXECUTE') AS app
           FROM pg_proc WHERE proname = 'example_orgs_with_purgeable_projects'`,
            )
          ).rows,
      );
      expect(row).toEqual([
        {
          owner: 'sweep_definer',
          prosecdef: true,
          proconfig: ['search_path=""'],
          pub: false,
          app: true,
        },
      ]);
      await expect(
        withOwner((c) =>
          c.query(
            'DROP FUNCTION public.example_orgs_with_purgeable_projects(uuid, integer, integer)',
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
  it('catalogue rows: three permissions with flags of table 7.2, two requires, two entitlement features', async () => {
    const rows = await withOwner(async (c) => ({
      perms: (
        await c.query(
          `SELECT key, owner_only, api_key_eligible, support_eligible FROM permissions WHERE resource = 'example_projects' ORDER BY key`,
        )
      ).rows,
      requires: (
        await c.query(
          `SELECT p.key || '>' || r.key AS k FROM permission_requires x JOIN permissions p ON p.id = x.permission_id
         JOIN permissions r ON r.id = x.required_permission_id WHERE p.resource = 'example_projects' ORDER BY 1`,
        )
      ).rows.map((r) => r.k),
      features: (
        await c.query(
          `SELECT key, kind, reset_period FROM entitlement_features WHERE key LIKE 'example.%' ORDER BY key`,
        )
      ).rows,
    }));
    expect(rows).toEqual({
      perms: [
        {
          key: 'example_projects.delete',
          owner_only: false,
          api_key_eligible: false,
          support_eligible: false,
        },
        {
          key: 'example_projects.read',
          owner_only: false,
          api_key_eligible: true,
          support_eligible: true,
        },
        {
          key: 'example_projects.write',
          owner_only: false,
          api_key_eligible: true,
          support_eligible: false,
        },
      ],
      requires: [
        'example_projects.delete>example_projects.read',
        'example_projects.write>example_projects.read',
      ],
      features: [
        { key: 'example.project_count', kind: 'QUOTA', reset_period: 'NONE' },
        { key: 'example.projects', kind: 'FLAG', reset_period: null },
      ],
    });
  });
});
