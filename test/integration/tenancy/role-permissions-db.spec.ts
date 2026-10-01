import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  Db,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import { ROLE_NAME_MAX_LENGTH } from '../../../src/modules/tenancy/constants.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import {
  TENANCY_ONLY_CATALOGUE,
  inOrgTx,
  roleSetC1,
  seedCustomRole,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';

/** Test DB không có app tenancy: một tập đóng có thật trong DB (members.role.assign cần members.read, roles.read). */
const C1 = roleSetC1(TENANCY_ONLY_CATALOGUE);
const LOCK_WAIT_POLL_MS = 20;
const LOCK_WAIT_MAX_POLLS = 250;
const permId = (key: string) =>
  `(SELECT id FROM permissions WHERE key = '${key}')`;
const constraintOf = (err: unknown) =>
  typeof err === 'object' && err !== null && 'constraint' in err
    ? err.constraint
    : undefined;

describe('org_role_permissions: isolation, guard, closure and races (spec SP3 §6.5, §18.1, tiêu chí 1)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  let roleA: SeededRole;
  let roleB: SeededRole;
  const inA = <T>(fn: () => Promise<T>) =>
    app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) =>
    app.get(Db).execute<T>(q, p);
  const rowsOfB = () =>
    withAppClient((c) =>
      inOrgTx(
        c,
        b.orgId,
        async () =>
          (
            await c.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM org_role_permissions',
            )
          ).rows[0]?.n,
      ),
    );
  /** Một transaction của app_user trong OrgScope(org); trả lỗi của COMMIT (trigger hoãn) thay vì ném. */
  const commitErr = (org: string, body: (c: pg.Client) => Promise<unknown>) =>
    withAppClient(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      try {
        await body(c);
      } catch (err) {
        await c.query('ROLLBACK');
        return err;
      }
      return c.query('COMMIT').then(
        () => undefined,
        (e: unknown) => e,
      );
    });

  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    a = await seedOrg();
    b = await seedOrg();
    roleA = await seedCustomRole(a, { permissions: C1 });
    roleB = await seedCustomRole(b, { permissions: C1 });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await app?.close();
  });

  describe('isolation (tiêu chí 1)', () => {
    it('SELECT and DELETE of org B rows from OrgScope(A) touch 0 rows; app_user has no UPDATE at all', async () => {
      const before = await rowsOfB();
      expect(before).toBe(C1.length);
      expect(
        await inA(() =>
          sql('SELECT 1 FROM org_role_permissions WHERE org_id = ?', [b.orgId]),
        ),
      ).toEqual([]);
      expect(
        await inA(() =>
          sql('DELETE FROM org_role_permissions WHERE org_id = ? RETURNING 1', [
            b.orgId,
          ]),
        ),
      ).toEqual([]);
      await expect(
        inA(() =>
          sql(
            'UPDATE org_role_permissions SET updated_at = now() WHERE org_id = ?',
            [b.orgId],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      expect(await rowsOfB()).toBe(before);
    });
    it('INSERT with org_id = B is refused by RLS (42501), not by the guard (spike S3B-2)', async () => {
      await expect(
        inA(() =>
          sql(
            `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES (?, ?, ${permId('org.read')})`,
            [b.orgId, roleB.id],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
    it('without an org context it fails closed (P0001)', async () => {
      await expect(
        app
          .get(UnitOfWork)
          .run(() => sql('SELECT 1 FROM org_role_permissions')),
      ).rejects.toThrow(/org context is not set/);
    });
    it('a row in A pointing at a role of B violates the composite FK (23503)', async () => {
      await expect(
        inA(() =>
          sql(
            `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES (?, ?, ${permId('org.read')})`,
            [a.orgId, roleB.id],
          ),
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'org_role_permissions_role_fk',
      });
    });
  });

  describe('guard and closure (spec §6.5, §18.1)', () => {
    it.each([
      [
        'a system role',
        () => a.roles.ADMIN.id,
        'org.read',
        'org_role_permissions_custom_only',
      ],
      [
        'an ownerOnly permission',
        () => roleA.id,
        'org.delete',
        'org_role_permissions_not_delegable',
      ],
    ])(
      '%s is refused by the BEFORE INSERT guard (23514)',
      async (_name, role, key, constraint) => {
        const err = await commitErr(a.orgId, (c) =>
          c.query(
            `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId(key)})`,
            [a.orgId, role()],
          ),
        );
        expect({
          code: (err as { code?: string }).code,
          constraint: constraintOf(err),
        }).toEqual({ code: '23514', constraint });
      },
    );
    it('a deprecated permission is refused by the guard (deprecate inside the owner transaction, then roll back)', async () => {
      const { pg: p } = getInfra();
      const owner = new pg.Client({
        host: p.host,
        port: p.port,
        database: p.database,
        ...p.owner,
      });
      await owner.connect();
      try {
        // Mọi thay đổi nằm trong MỘT transaction của owner rồi ROLLBACK: bảng global `permissions` và cờ FORCE không bao
        // giờ lệch với file test sau. NO FORCE để owner (không policy) thấy dòng role cho guard.
        await owner.query('BEGIN');
        await owner.query(
          `UPDATE permissions SET deprecated_at = now() WHERE key = 'invitations.read'`,
        );
        await owner.query(
          'ALTER TABLE org_role_permissions NO FORCE ROW LEVEL SECURITY',
        );
        await owner.query('ALTER TABLE org_roles NO FORCE ROW LEVEL SECURITY');
        await expect(
          owner.query(
            `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('invitations.read')})`,
            [a.orgId, roleA.id],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'org_role_permissions_deprecated',
        });
      } finally {
        await owner.query('ROLLBACK');
        await owner.end();
      }
    });
    it('a non-closed set is refused at COMMIT with org_role_permissions_closed_ck, even after switching app.org_id', async () => {
      for (const switchOrg of [false, true]) {
        const err = await commitErr(a.orgId, async (c) => {
          await c.query(
            `DELETE FROM org_role_permissions WHERE role_id = $1 AND permission_id = ${permId('members.read')}`,
            [roleA.id],
          );
          if (switchOrg)
            await c.query(`SELECT set_config('app.org_id', $1, true)`, [
              b.orgId,
            ]);
        });
        expect({
          code: (err as { code?: string }).code,
          constraint: constraintOf(err),
        }).toEqual({
          code: '23514',
          constraint: 'org_role_permissions_closed_ck',
        });
      }
    });
    it('a multi-statement replacement valid only at the end commits (the check is deferred)', async () => {
      const r = await seedCustomRole(a, { permissions: ['org.read'] });
      const err = await commitErr(a.orgId, async (c) => {
        await c.query(
          `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('roles.write')})`,
          [a.orgId, r.id],
        );
        await c.query(
          `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('roles.read')})`,
          [a.orgId, r.id],
        );
      });
      expect(err).toBeUndefined();
    });
    it('deleting a custom role cascades its rows; deleting a role with a member is 23001 org_members_role_fk', async () => {
      const lone = await seedCustomRole(a, { permissions: C1 });
      expect(
        await commitErr(a.orgId, (c) =>
          c.query('DELETE FROM org_roles WHERE id = $1', [lone.id]),
        ),
      ).toBeUndefined();
      expect(
        await withAppClient((c) =>
          inOrgTx(
            c,
            a.orgId,
            async () =>
              (
                await c.query(
                  'SELECT 1 FROM org_role_permissions WHERE role_id = $1',
                  [lone.id],
                )
              ).rows,
          ),
        ),
      ).toEqual([]);
      const held = await seedCustomRole(a, { permissions: C1 });
      await seedMemberInRole(a, held);
      const err = await commitErr(a.orgId, (c) =>
        c.query('DELETE FROM org_roles WHERE id = $1', [held.id]),
      );
      expect({
        code: (err as { code?: string }).code,
        constraint: constraintOf(err),
      }).toEqual({ code: '23001', constraint: 'org_members_role_fk' });
    });
    it('the closure check refuses REPEATABLE READ (it relies on a fresh snapshot after its lock)', async () => {
      const err = await withAppClient(async (c) => {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [a.orgId]);
        await c.query(
          `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('org.update')})`,
          [a.orgId, roleA.id],
        );
        return c.query('COMMIT').then(
          () => undefined,
          (e: unknown) => e,
        );
      });
      expect(constraintOf(err)).toBe('org_role_permissions_closed_ck');
    });
    it(`the name CHECK counts code points like ROLE_NAME_MAX_LENGTH (${ROLE_NAME_MAX_LENGTH})`, async () => {
      const ok = await commitErr(a.orgId, (c) =>
        c.query(`INSERT INTO org_roles (org_id, name) VALUES ($1, $2)`, [
          a.orgId,
          '😀'.repeat(ROLE_NAME_MAX_LENGTH),
        ]),
      );
      expect(ok).toBeUndefined();
      const tooLong = await commitErr(a.orgId, (c) =>
        c.query(`INSERT INTO org_roles (org_id, name) VALUES ($1, $2)`, [
          a.orgId,
          '😀'.repeat(ROLE_NAME_MAX_LENGTH + 1),
        ]),
      );
      expect(constraintOf(tooLong)).toBe('org_roles_name_ck');
    });
  });

  describe('R3B-1: write skew between two connections with no lock in the callers (deterministic, 3A definer-triggers pattern)', () => {
    const SKEW_STEP = {
      add: `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('roles.write')})`,
      drop: `DELETE FROM org_role_permissions WHERE org_id = $1 AND role_id = $2 AND permission_id = ${permId('roles.read')}`,
    } as const;
    /** Chờ tới khi backend `pid` đứng chờ một khoá advisory; kết nối thứ ba (`pg_locks` là view toàn cluster, app_user đọc được). */
    const waitForAdvisoryWait = (pid: number) =>
      withAppClient(async (probe) => {
        for (let i = 0; i < LOCK_WAIT_MAX_POLLS; i++) {
          const { rows } = await probe.query(
            `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
            [pid],
          );
          if (rows.length > 0) return;
          await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
        }
        throw new Error(`session ${pid} never waited on an advisory lock`);
      });
    const storedKeys = (roleId: string) =>
      withAppClient((c) =>
        inOrgTx(c, a.orgId, async () =>
          (
            await c.query<{ key: string }>(
              `SELECT p.key FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY p.key`,
              [roleId],
            )
          ).rows.map((r) => r.key),
        ),
      );
    it.each([
      [
        'add the dependant first, then drop its requirement',
        'add',
        'drop',
        ['org.read', 'roles.read', 'roles.write'],
      ],
      [
        'drop the requirement first, then add its dependant',
        'drop',
        'add',
        ['org.read'],
      ],
    ] as const)(
      '%s → the later COMMIT waits on the advisory lock, then is refused; the stored set stays closed',
      async (_n, first, second, kept) => {
        const r = await seedCustomRole(a, {
          permissions: ['org.read', 'roles.read'],
        });
        await withAppClient((x) =>
          withAppClient(async (y) => {
            for (const c of [x, y]) {
              await c.query('BEGIN');
              await c.query(`SELECT set_config('app.org_id', $1, true)`, [
                a.orgId,
              ]);
            }
            await x.query(SKEW_STEP[first], [a.orgId, r.id]);
            // x kiểm closure NGAY (tập của x còn đóng) và giữ khoá advisory của org tới hết transaction.
            await x.query(
              'SET CONSTRAINTS org_role_permissions_closed_ck IMMEDIATE',
            );
            await y.query(SKEW_STEP[second], [a.orgId, r.id]);
            const pid = (
              await y.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
            ).rows[0]!.pid;
            const yCommit = y.query('COMMIT').then(
              () => undefined,
              (e: unknown) => e,
            );
            await waitForAdvisoryWait(pid);
            await x.query('COMMIT');
            const err = await yCommit;
            expect({
              code: (err as { code?: string } | undefined)?.code,
              constraint: constraintOf(err),
            }).toEqual({
              code: '23514',
              constraint: 'org_role_permissions_closed_ck',
            });
          }),
        );
        expect(await storedKeys(r.id)).toEqual(kept);
      },
    );
  });
});
