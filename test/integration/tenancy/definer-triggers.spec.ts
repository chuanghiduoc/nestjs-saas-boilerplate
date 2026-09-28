import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../support/infra.js';

/**
 * Trigger bất biến của `tenancy_core` (spec SP3 §6.4–6.6, §17 T-1, T-23, T-28): ba trigger hoãn là `SECURITY DEFINER`
 * của `tenancy_definer`, nên câu kiểm lúc COMMIT thấy trạng thái thật của org dù `app.org_id` đã đổi giữa transaction;
 * `last_owner` và `restore_owner` tuần tự hoá bằng khoá advisory theo org.
 */
const CHECK_VIOLATION = '23514';
const LOCK_WAIT_POLL_MS = 20;
const LOCK_WAIT_MAX_POLLS = 250;

type Org = {
  orgId: string;
  roles: Record<'OWNER' | 'ADMIN' | 'MEMBER', string>;
  ownerMemberId: string;
};

function pgError(e: unknown): { code?: string; constraint?: string } {
  if (e instanceof Error && 'code' in e) {
    const { code, constraint } = e as Error & {
      code?: string;
      constraint?: string;
    };
    return { code, constraint };
  }
  throw e;
}

async function rejectsWith(
  p: Promise<unknown>,
  constraint: string,
): Promise<void> {
  const outcome = await p.then(
    () => ({ code: 'none', constraint: 'none' }),
    pgError,
  );
  expect(outcome).toEqual({ code: CHECK_VIOLATION, constraint });
}

describe('tenancy_core invariant triggers (spec SP3 §6.4–6.6)', () => {
  const clients: pg.Client[] = [];
  let app: pg.Client;
  let other: Org;

  async function connect(): Promise<pg.Client> {
    const { pg: p } = getInfra();
    const c = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.app,
    });
    await c.connect();
    clients.push(c);
    return c;
  }
  const inOrg = (c: pg.Client, orgId: string) =>
    c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);

  async function addMember(
    c: pg.Client,
    org: Org,
    role: keyof Org['roles'],
  ): Promise<string> {
    const u = await c.query<{ id: string }>(
      `INSERT INTO tenancy_users (external_subject) VALUES ($1) RETURNING id`,
      [`t13-${randomUUID()}`],
    );
    const m = await c.query<{ id: string }>(
      `INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3) RETURNING id`,
      [org.orgId, u.rows[0]!.id, org.roles[role]],
    );
    return m.rows[0]!.id;
  }

  async function seedOrg(): Promise<Org> {
    const { rows } = await app.query<{ id: string }>('SELECT uuidv7() AS id');
    const orgId = rows[0]!.id;
    await app.query('BEGIN');
    try {
      await inOrg(app, orgId);
      await app.query(
        `INSERT INTO organizations (id, name) VALUES ($1, 'T13')`,
        [orgId],
      );
      const r = await app.query<{ id: string; system_key: string }>(
        `INSERT INTO org_roles (org_id, system_key) VALUES ($1, 'OWNER'), ($1, 'ADMIN'), ($1, 'MEMBER')
         RETURNING id, system_key`,
        [orgId],
      );
      const role = (k: string) => r.rows.find((x) => x.system_key === k)!.id;
      const org: Org = {
        orgId,
        roles: {
          OWNER: role('OWNER'),
          ADMIN: role('ADMIN'),
          MEMBER: role('MEMBER'),
        },
        ownerMemberId: '',
      };
      org.ownerMemberId = await addMember(app, org, 'OWNER');
      await app.query('COMMIT');
      return org;
    } catch (e) {
      await app.query('ROLLBACK');
      throw e;
    }
  }

  async function softDeleteWithoutOwner(org: Org): Promise<void> {
    await app.query('BEGIN');
    await inOrg(app, org.orgId);
    await app.query(
      `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
    );
    await app.query(`DELETE FROM org_members WHERE id = $1`, [
      org.ownerMemberId,
    ]);
    await app.query('COMMIT');
  }

  async function owners(orgId: string): Promise<number> {
    await app.query('BEGIN');
    await inOrg(app, orgId);
    const { rows } = await app.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE r.system_key = 'OWNER'`,
    );
    await app.query('COMMIT');
    return rows[0]!.n;
  }

  /** Chờ tới khi phiên `pid` đứng chờ một khoá advisory (không ngủ cố định). */
  async function waitForAdvisoryWait(pid: number): Promise<void> {
    for (let i = 0; i < LOCK_WAIT_MAX_POLLS; i++) {
      const { rows } = await app.query(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
        [pid],
      );
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
    }
    throw new Error(`session ${pid} never waited on an advisory lock`);
  }

  beforeAll(async () => {
    app = await connect();
    other = await seedOrg();
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end()));
  });

  describe('switching app.org_id before COMMIT does not skip a deferred check', () => {
    it('organizations_bootstrap_ck: an org without roles or owner is rejected', async () => {
      const { rows } = await app.query<{ id: string }>('SELECT uuidv7() AS id');
      await app.query('BEGIN');
      await inOrg(app, rows[0]!.id);
      await app.query(
        `INSERT INTO organizations (id, name) VALUES ($1, 'bare')`,
        [rows[0]!.id],
      );
      await inOrg(app, other.orgId);
      await rejectsWith(app.query('COMMIT'), 'organizations_bootstrap_ck');
    });

    it('org_members_last_owner_ck: deleting or demoting the sole owner is rejected', async () => {
      const org = await seedOrg();
      await app.query('BEGIN');
      await inOrg(app, org.orgId);
      await app.query(`DELETE FROM org_members WHERE id = $1`, [
        org.ownerMemberId,
      ]);
      await inOrg(app, other.orgId);
      await rejectsWith(app.query('COMMIT'), 'org_members_last_owner_ck');

      await app.query('BEGIN');
      await inOrg(app, org.orgId);
      await app.query(`UPDATE org_members SET role_id = $2 WHERE id = $1`, [
        org.ownerMemberId,
        org.roles.MEMBER,
      ]);
      await inOrg(app, other.orgId);
      await rejectsWith(app.query('COMMIT'), 'org_members_last_owner_ck');
      expect(await owners(org.orgId)).toBe(1);
    });

    it('organizations_restore_owner_ck: restoring an org with no owner is rejected', async () => {
      const org = await seedOrg();
      await softDeleteWithoutOwner(org);
      await app.query('BEGIN');
      await inOrg(app, org.orgId);
      await app.query(
        `UPDATE organizations SET deleted_at = NULL, purge_after = NULL`,
      );
      await inOrg(app, other.orgId);
      await rejectsWith(app.query('COMMIT'), 'organizations_restore_owner_ck');
    });

    it('org_roles_system_immutable: another org context cannot reach the role, the own context is rejected', async () => {
      const org = await seedOrg();
      await app.query('BEGIN');
      await inOrg(app, other.orgId);
      const hidden = await app.query(`DELETE FROM org_roles WHERE id = $1`, [
        org.roles.ADMIN,
      ]);
      expect(hidden.rowCount).toBe(0);
      await inOrg(app, org.orgId);
      await rejectsWith(
        app.query(`DELETE FROM org_roles WHERE id = $1`, [org.roles.ADMIN]),
        'org_roles_system_immutable',
      );
      await app.query('ROLLBACK');
      await app.query('BEGIN');
      await inOrg(app, org.orgId);
      await rejectsWith(
        app.query(`UPDATE org_roles SET updated_at = now() WHERE id = $1`, [
          org.roles.ADMIN,
        ]),
        'org_roles_system_immutable',
      );
      await app.query('ROLLBACK');
    });
  });

  it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
    'organizations_restore_owner_ck refuses %s (it relies on a fresh snapshot after the lock)',
    async (level) => {
      const org = await seedOrg();
      await app.query('BEGIN');
      await inOrg(app, org.orgId);
      await app.query(
        `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
      );
      await app.query('COMMIT');
      await app.query(`BEGIN ISOLATION LEVEL ${level}`);
      await inOrg(app, org.orgId);
      await app.query(
        `UPDATE organizations SET deleted_at = NULL, purge_after = NULL`,
      );
      await rejectsWith(app.query('COMMIT'), 'organizations_restore_owner_ck');
    },
  );

  describe('the per-org advisory lock serialises the deferred checks (T-1, T-28)', () => {
    it('two sessions removing the two owners: the later check waits, then sees 0 owners and fails', async () => {
      const org = await seedOrg();
      await app.query('BEGIN');
      await inOrg(app, org.orgId);
      const second = await addMember(app, org, 'OWNER');
      await app.query('COMMIT');
      const [a, b] = [await connect(), await connect()];
      await b.query('BEGIN');
      await inOrg(b, org.orgId);
      await b.query(`DELETE FROM org_members WHERE id = $1`, [second]);
      // b chạy câu kiểm ngay (còn owner kia) và giữ khoá advisory của org tới hết transaction.
      await b.query('SET CONSTRAINTS org_members_last_owner_ck IMMEDIATE');
      await a.query('BEGIN');
      await inOrg(a, org.orgId);
      await a.query(`DELETE FROM org_members WHERE id = $1`, [
        org.ownerMemberId,
      ]);
      const pid = (
        await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      const aCommit = a.query('COMMIT');
      await waitForAdvisoryWait(pid);
      await b.query('COMMIT');
      await rejectsWith(aCommit, 'org_members_last_owner_ck');
      expect(await owners(org.orgId)).toBe(1);
    });

    it('a restore and the removal of the last owner: the removal waits, then sees an active org and fails', async () => {
      const org = await seedOrg();
      await app.query('BEGIN');
      await inOrg(app, org.orgId);
      await app.query(
        `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
      );
      await app.query('COMMIT');
      const [restorer, remover] = [await connect(), await connect()];
      await restorer.query('BEGIN');
      await inOrg(restorer, org.orgId);
      await restorer.query(
        `UPDATE organizations SET deleted_at = NULL, purge_after = NULL`,
      );
      await restorer.query(
        'SET CONSTRAINTS organizations_restore_owner_ck IMMEDIATE',
      );
      await remover.query('BEGIN');
      await inOrg(remover, org.orgId);
      await remover.query(`DELETE FROM org_members WHERE id = $1`, [
        org.ownerMemberId,
      ]);
      const pid = (
        await remover.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      const removerCommit = remover.query('COMMIT');
      await waitForAdvisoryWait(pid);
      await restorer.query('COMMIT');
      await rejectsWith(removerCommit, 'org_members_last_owner_ck');
      expect(await owners(org.orgId)).toBe(1);
    });
  });
});
