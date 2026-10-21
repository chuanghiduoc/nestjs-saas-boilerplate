import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import {
  seedCounter,
  seedOrgEntitlement,
} from '../../../support/entitlements-seed.js';
import { coreMigrationList } from '../../../support/migrate-test-db.js';
import {
  createScratchDb,
  type ScratchDb,
} from '../../../support/scratch-db.js';
import {
  inOrgTx,
  seedCustomRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../../support/tenancy-seed.js';

const REFUSAL = /example_projects is not empty/;
const PG_RESTRICT = '23001';
const UP = {
  table: 'example_projects',
  force: true,
  fnOwner: 'sweep_definer',
  permissions: 3,
  requires: 2,
  features: 2,
};

/**
 * EX-I13 (spec SP7 §7.5) trên database riêng (down để lại schema khác DB dùng chung). Danh sách migration cắt tới
 * `…_example_projects` để down chỉ lùi đúng migration này dù sau này có migration mới hơn.
 */
describe('example_projects migration down (spec §7.5, EX-I13)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let before: string;
  let org: SeededOrg;
  const inOrgDb = <T>(fn: (c: pg.Client) => Promise<T>) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)), db.name);
  const catalogState = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{
          table: string | null;
          force: boolean | null;
          fnOwner: string | null;
          permissions: number;
          requires: number;
          features: number;
        }>(
          `SELECT to_regclass('public.example_projects')::text AS table,
                  (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.example_projects')) AS force,
                  (SELECT pg_get_userbyid(proowner) FROM pg_proc
                    WHERE oid = to_regprocedure('public.example_orgs_with_purgeable_projects(uuid, integer, integer)')) AS "fnOwner",
                  (SELECT count(*)::int FROM permissions WHERE resource = 'example_projects') AS permissions,
                  (SELECT count(*)::int FROM permission_requires x JOIN permissions p ON p.id = x.permission_id
                    WHERE p.resource = 'example_projects') AS requires,
                  (SELECT count(*)::int FROM entitlement_features WHERE key IN ('example.projects', 'example.project_count')) AS features`,
        )
      ).rows[0];
    } finally {
      await c.end();
    }
  };
  const down = () =>
    runMigrations('down', { source: { kind: 'list', list }, to: before });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('exdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_example_projects'));
    if (at < 1) throw new Error('example_projects migration not found');
    list = all.slice(0, at + 1);
    before = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
    // `usage_counters_org_fk` → `org_entitlements`: bộ đếm chỉ có ở org đã có dòng gói.
    await seedOrgEntitlement(org.orgId, 'free', {}, db.name);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('up → down → up on an empty table; the sweep of S2-R57 leaves nothing behind', async () => {
    expect(await catalogState()).toEqual(UP);
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    expect(await catalogState()).toEqual({
      table: null,
      force: null,
      fnOwner: null,
      permissions: 0,
      requires: 0,
      features: 0,
    });
    await runMigrations('up', { source: { kind: 'list', list } });
    expect(await catalogState()).toEqual(UP);
  });
  it('down with a project row → RAISE "example_projects is not empty", DB unchanged (FORCE still on)', async () => {
    await inOrgDb((c) =>
      c.query(
        `INSERT INTO example_projects (org_id, name) VALUES (app_current_org(), 'kept')`,
      ),
    );
    await expect(down()).rejects.toThrow(REFUSAL);
    expect(await catalogState()).toEqual(UP);
    const rows = await inOrgDb((c) =>
      c.query('DELETE FROM example_projects RETURNING 1'),
    );
    expect(rows.rowCount).toBe(1);
  });
  it('down while a custom role holds example_projects.read → 23001 (FK RESTRICT, D7-5), DB unchanged', async () => {
    const role = await seedCustomRole(org, {
      permissions: ['example_projects.read'],
    });
    await expect(down()).rejects.toMatchObject({
      code: PG_RESTRICT,
      constraint: 'org_role_permissions_permission_fk',
    });
    expect(await catalogState()).toEqual(UP);
    await inOrgDb(async (c) => {
      await c.query('DELETE FROM org_role_permissions WHERE role_id = $1', [
        role.id,
      ]);
      await c.query('DELETE FROM org_roles WHERE id = $1', [role.id]);
    });
  });
  it('down after a usage_counters row exists for example.project_count → 23001, DB unchanged', async () => {
    await seedCounter(
      org.orgId,
      'example.project_count',
      { used: 1, period: 'NONE' },
      db.name,
    );
    await expect(down()).rejects.toMatchObject({
      code: PG_RESTRICT,
      constraint: 'usage_counters_feature_fk',
    });
    expect(await catalogState()).toEqual(UP);
    await inOrgDb((c) => c.query('DELETE FROM usage_counters'));
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
  });
});
