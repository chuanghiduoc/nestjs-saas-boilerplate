import pg from 'pg';
import { v4, v7 } from 'uuid';
import { afterAll, describe, expect, it } from 'vitest';
import { TENANCY_CATALOGUE } from '../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { getInfra } from '../../support/infra.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/**
 * Bất biến DB của `tenancy_core` (spec SP3 §6.2–6.6) và race không khoá ở caller (O-3, O-13/T-28, O-14, T-23).
 * Các ca "đổi `app.org_id` trước COMMIT", REPEATABLE READ của `restore_owner_ck` và race hai phiên có thứ tự tất định
 * (chờ khoá advisory thấy được qua `pg_locks`) nằm ở `definer-triggers.spec.ts`; file này không lặp lại chúng.
 */
const RACE_ROUNDS = 50;
const disposers: SeededOrg[] = [];
const seed = async () => {
  const o = await seedOrg();
  disposers.push(o);
  return o;
};
afterAll(async () => {
  // Dọn MỌI org dù một lần dispose lỗi, rồi mới fail to với đủ các lỗi.
  const failed = (
    await Promise.allSettled(disposers.map((o) => o.dispose()))
  ).filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0)
    throw new AggregateError(
      failed.map((r) => r.reason),
      `${failed.length} seeded org(s) failed to dispose`,
    );
});
const rejectsWith = (p: Promise<unknown>, code: string, constraint?: string) =>
  expect(p).rejects.toMatchObject(constraint ? { code, constraint } : { code });
const owners = (c: pg.Client) =>
  c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`,
  );
const appClient = () => {
  const { pg: p } = getInfra();
  return new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.app,
  });
};

describe('last owner (spec SP3 §6.6, O-3, O-13, T-1, T-28)', () => {
  it('O-3: deleting or demoting the only owner of an active org fails at COMMIT (23514 org_members_last_owner_ck)', async () => {
    const o = await seed();
    await withAppClient(async (c) => {
      await rejectsWith(
        inOrgTx(c, o.orgId, () =>
          c.query(`DELETE FROM org_members WHERE id = $1`, [o.owner.memberId]),
        ),
        '23514',
        'org_members_last_owner_ck',
      );
      await rejectsWith(
        inOrgTx(c, o.orgId, () =>
          c.query(`UPDATE org_members SET role_id = $2 WHERE id = $1`, [
            o.owner.memberId,
            o.roles.MEMBER.id,
          ]),
        ),
        '23514',
        'org_members_last_owner_ck',
      );
      expect((await inOrgTx(c, o.orgId, () => owners(c))).rows[0]?.n).toBe(1);
    });
  });
  it(`O-13 / T-28: two app_user connections deleting two owners without locking the org, ×${RACE_ROUNDS} → the org always keeps an owner`, async () => {
    const o = await seed();
    const [a, b] = [appClient(), appClient()];
    await Promise.all([a.connect(), b.connect()]);
    try {
      for (let i = 0; i < RACE_ROUNDS; i++) {
        const x = await seedMember(o, 'OWNER');
        const y = await seedMember(o, 'OWNER');
        // Đúng hai owner (x, y) trước mỗi vòng: xoá mọi owner khác bằng một transaction thường (hợp lệ vì x, y còn).
        await withAppClient((c) =>
          inOrgTx(c, o.orgId, () =>
            c.query(
              `DELETE FROM org_members WHERE role_id = $1 AND id <> ALL($2::bigint[])`,
              [o.roles.OWNER.id, [x.memberId, y.memberId]],
            ),
          ),
        );
        for (const [conn, m] of [
          [a, x],
          [b, y],
        ] as const) {
          await conn.query('BEGIN');
          await conn.query(`SELECT set_config('app.org_id', $1, true)`, [
            o.orgId,
          ]);
          await conn.query(`DELETE FROM org_members WHERE id = $1`, [
            m.memberId,
          ]);
        }
        const results = await Promise.allSettled([
          a.query('COMMIT'),
          b.query('COMMIT'),
        ]);
        const left = await withAppClient((c) =>
          inOrgTx(c, o.orgId, () => owners(c)),
        );
        expect(left.rows[0]?.n, `round ${i}`).toBe(1);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected, `round ${i}`).toHaveLength(1);
        expect(rejected[0]?.reason, `round ${i}`).toMatchObject({
          code: '23514',
          constraint: 'org_members_last_owner_ck',
        });
      }
    } finally {
      await a.end();
      await b.end();
    }
  });
  it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
    'the last-owner trigger refuses %s (its correctness relies on a fresh snapshot after the lock)',
    async (level) => {
      const o = await seed();
      const admin = await seedMember(o, 'ADMIN');
      await withAppClient(async (c) => {
        await c.query(`BEGIN ISOLATION LEVEL ${level}`);
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [o.orgId]);
        await c.query(`DELETE FROM org_members WHERE id = $1`, [
          admin.memberId,
        ]);
        await rejectsWith(
          c.query('COMMIT'),
          '23514',
          'org_members_last_owner_ck',
        );
      });
    },
  );
  it('a soft-deleted org is exempt (account deletion must not be blocked by a deleted org, S3-A12)', async () => {
    const o = await seed();
    await withAppClient((c) =>
      inOrgTx(c, o.orgId, async () => {
        await c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
        );
        await c.query(`DELETE FROM org_members WHERE id = $1`, [
          o.owner.memberId,
        ]);
      }),
    );
    expect(
      (await withAppClient((c) => inOrgTx(c, o.orgId, () => owners(c)))).rows[0]
        ?.n,
    ).toBe(0);
  });
});

describe('restore and bootstrap (spec SP3 §6.4, O-14, T-23)', () => {
  it('O-14: restoring an org with no owner left fails at COMMIT (23514 organizations_restore_owner_ck)', async () => {
    const o = await seed();
    await withAppClient(async (c) => {
      await inOrgTx(c, o.orgId, async () => {
        await c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
        );
        await c.query(`DELETE FROM org_members`);
      });
      await rejectsWith(
        inOrgTx(c, o.orgId, () =>
          c.query(
            `UPDATE organizations SET deleted_at = NULL, purge_after = NULL`,
          ),
        ),
        '23514',
        'organizations_restore_owner_ck',
      );
    });
  });
  it('T-23: an org without its three system roles or without an owner cannot commit', async () => {
    await withAppClient(async (c) => {
      const noRoles = v7();
      await rejectsWith(
        inOrgTx(c, noRoles, () =>
          c.query(`INSERT INTO organizations (id, name) VALUES ($1, 'x')`, [
            noRoles,
          ]),
        ),
        '23514',
        'organizations_bootstrap_ck',
      );
      const noOwner = v7();
      await rejectsWith(
        inOrgTx(c, noOwner, async () => {
          await c.query(
            `INSERT INTO organizations (id, name) VALUES ($1, 'x')`,
            [noOwner],
          );
          await c.query(
            `INSERT INTO org_roles (org_id, system_key) VALUES ($1, 'OWNER'), ($1, 'ADMIN'), ($1, 'MEMBER')`,
            [noOwner],
          );
        }),
        '23514',
        'organizations_bootstrap_ck',
      );
    });
  });
  it('deleting an org that still has children is refused (23001), even while soft-deleted', async () => {
    const o = await seed();
    await withAppClient((c) =>
      rejectsWith(
        inOrgTx(c, o.orgId, async () => {
          await c.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
          );
          await c.query(`DELETE FROM organizations`);
        }),
        '23001',
      ),
    );
  });
});

describe('system roles and row shapes (spec SP3 §6.2–6.5)', () => {
  it('a system role cannot be updated or deleted while the org is active (23514 org_roles_system_immutable)', async () => {
    const o = await seed();
    await withAppClient(async (c) => {
      await rejectsWith(
        inOrgTx(c, o.orgId, () =>
          c.query(`UPDATE org_roles SET updated_at = now() WHERE id = $1`, [
            o.roles.ADMIN.id,
          ]),
        ),
        '23514',
        'org_roles_system_immutable',
      );
      await rejectsWith(
        inOrgTx(c, o.orgId, () =>
          c.query(`DELETE FROM org_roles WHERE id = $1`, [o.roles.ADMIN.id]),
        ),
        '23514',
        'org_roles_system_immutable',
      );
    });
  });
  it.each([
    [
      'both subjects NULL',
      `INSERT INTO tenancy_users DEFAULT VALUES`,
      [],
      'tenancy_users_one_subject_ck',
    ],
    [
      'both subjects set',
      `INSERT INTO tenancy_users (auth_user_id, external_subject) VALUES ($1, 'x')`,
      [v4()],
      'tenancy_users_one_subject_ck',
    ],
    [
      'a 256-char subject',
      `INSERT INTO tenancy_users (external_subject) VALUES ($1)`,
      ['s'.repeat(256)],
      'tenancy_users_external_subject_ck',
    ],
  ])('tenancy_users: %s → 23514', async (_n, sql, params, constraint) => {
    await withAppClient(async (c) => {
      await c.query('BEGIN');
      await rejectsWith(c.query(sql, params), '23514', constraint);
      await c.query('ROLLBACK');
    });
  });
  it.each([
    ['a v4 id', v4(), 'Name', 'organizations_id_v7_ck'],
    ['a padded name', v7(), ' Name', 'organizations_name_ck'],
    ['a 101-code-point name', v7(), '😀'.repeat(101), 'organizations_name_ck'],
  ])('organizations: %s → 23514', async (_n, id, name, constraint) => {
    await withAppClient((c) =>
      rejectsWith(
        inOrgTx(c, id, () =>
          c.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
            id,
            name,
          ]),
        ),
        '23514',
        constraint,
      ),
    );
  });
  it('permissions: app_user is read-only; the CHECKs refuse wildcards and malformed keys (owner, rolled back)', async () => {
    await withAppClient((c) =>
      rejectsWith(
        c.query(
          `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('x', 'y', false, false, false)`,
        ),
        '42501',
      ),
    );
    const { pg: p } = getInfra();
    const owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
    try {
      const bad: [string, string, string][] = [
        ['org', 'manage', 'permissions_action_ck'],
        ['all', 'read', 'permissions_resource_ck'],
        ['_x', 'read', 'permissions_resource_ck'],
        ['org', 'a.b.c', 'permissions_action_ck'],
        ['org', 'Read', 'permissions_action_ck'],
      ];
      for (const [resource, action, constraint] of bad) {
        await owner.query('BEGIN');
        await rejectsWith(
          owner.query(
            `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ($1, $2, false, false, false)`,
            [resource, action],
          ),
          '23514',
          constraint,
        );
        await owner.query('ROLLBACK');
      }
      await owner.query('BEGIN');
      await rejectsWith(
        owner.query(
          `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('org', 'x', true, true, false)`,
        ),
        '23514',
        'permissions_owner_only_ck',
      );
      await owner.query('ROLLBACK');
      const catalogue = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM permissions WHERE key = ANY($1::text[])`,
        [[...TENANCY_CATALOGUE.keys]],
      );
      expect(catalogue.rows).toEqual([{ n: TENANCY_CATALOGUE.keys.length }]);
    } finally {
      await owner.end();
    }
  });
});

describe('FOR NO KEY UPDATE on the org row never blocks a child INSERT (spec SP3 §3.13, DB-I3)', () => {
  it('a feature INSERT with an FK to organizations proceeds while an admin transaction holds the org lock', async () => {
    const o = await seed();
    const holder = appClient();
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [
        o.orgId,
      ]);
      await holder.query(
        `SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`,
        [o.orgId],
      );
      await withAppClient(async (c) => {
        await c.query(`SET lock_timeout = '1s'`);
        await inOrgTx(c, o.orgId, () =>
          c.query(`INSERT INTO fixture_org_items (org_id) VALUES ($1)`, [
            o.orgId,
          ]),
        );
        await inOrgTx(c, o.orgId, () =>
          c.query(`DELETE FROM fixture_org_items`),
        );
      });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });
});
