import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/**
 * Spec SP3 §6.13 "Down khi có dữ liệu chặn → lỗi rõ ràng, không mất dữ liệu" áp cho 3B: bỏ bảng khi còn role tuỳ biến
 * làm member giữ role đó mất mọi quyền, và code 3A (sau rollback) ném 500 cho role tuỳ biến. Database riêng, migrate tới
 * đúng migration 3B, nên không phụ thuộc migration của 3C/3D.
 */
describe('down of …_custom_role_permissions refuses while a custom role exists', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  let org: SeededOrg;
  let roleId: string;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('crpdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) =>
      m.name.endsWith('_custom_role_permissions'),
    );
    if (at < 1) throw new Error('custom_role_permissions migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
    roleId = await withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, async () => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO org_roles (org_id, name) VALUES ($1, 'Kept') RETURNING id::text AS id`,
            [org.orgId],
          );
          await c.query(
            `INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`,
            [org.orgId, rows[0]!.id],
          );
          return rows[0]!.id;
        }),
      db.name,
    );
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('a custom role seeded by app_user blocks the down; the table, the row and FORCE stay', async () => {
    await expect(
      runMigrations('down', { source: { kind: 'list', list }, to: previous }),
    ).rejects.toThrow(/custom roles exist/);
    const owner = await db.client('owner');
    try {
      expect(
        (
          await owner.query(
            `SELECT to_regclass('public.org_role_permissions') IS NOT NULL AS present`,
          )
        ).rows,
      ).toEqual([{ present: true }]);
      expect(
        (
          await owner.query(
            `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'org_roles'`,
          )
        ).rows,
      ).toEqual([{ relforcerowsecurity: true }]);
    } finally {
      await owner.end();
    }
    const kept = await withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, () =>
          c.query(`SELECT 1 FROM org_role_permissions WHERE role_id = $1`, [
            roleId,
          ]),
        ),
      db.name,
    );
    expect(kept.rows).toHaveLength(1);
  });
  it('once the custom role is gone the down succeeds and drops both functions', async () => {
    await withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, () =>
          c.query(`DELETE FROM org_roles WHERE id = $1`, [roleId]),
        ),
      db.name,
    );
    await expect(
      runMigrations('down', { source: { kind: 'list', list }, to: previous }),
    ).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      const { rows } = await owner.query(
        `SELECT proname FROM pg_proc WHERE proname IN ('tenancy_org_role_permissions_guard', 'tenancy_permission_scope_closed_ck')`,
      );
      expect(rows).toEqual([]);
    } finally {
      await owner.end();
    }
  });
});
