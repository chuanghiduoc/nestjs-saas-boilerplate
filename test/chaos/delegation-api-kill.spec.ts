import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../support/app-process.js';
import { baseTestEnv } from '../support/env.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { exitCode } from '../support/spawn-worker.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../support/tenancy-seed.js';

const WAIT_MS = 60_000;
const API_ENTRY = 'test/support/api-entry.ts';
const PROCESS_ENV: Record<string, string> = {
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
};
/** Quyền mà cả key của ca dưới lẫn preset support đều chứa: dòng `permissions` test khoá. */
const LOCKED_PERMISSION = 'org.read';

const until = async (
  pred: () => Promise<boolean>,
  ms = WAIT_MS,
): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const startApi = async (): Promise<AppProcess & { port: number }> => {
  const api = await startAppProcess(API_ENTRY, {
    ...baseTestEnv(),
    ...PROCESS_ENV,
  });
  if (api.port === undefined) {
    await stopAppProcess(api);
    throw new Error('api-entry reported no port');
  }
  return { ...api, port: api.port };
};
const post = (port: number, bearer: string, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'idempotency-key': `kill-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

type Case = {
  name: string;
  table: string;
  bridge: string;
  event: string;
  path: (orgId: string) => string;
  body: (staffAuthUserId: string) => unknown;
};
const CASES: Case[] = [
  {
    name: 'org API key creation',
    table: 'org_api_keys',
    bridge: 'org_api_key_permissions',
    event: 'tenancy.api_key.created',
    path: (o) => `/v1/orgs/${o}/api-keys`,
    body: () => ({
      name: 'kill',
      permissions: [LOCKED_PERMISSION],
      expiresInSec: 600,
    }),
  },
  {
    name: 'support grant',
    table: 'org_support_grants',
    bridge: 'org_support_grant_permissions',
    event: 'tenancy.support_access.granted',
    path: (o) => `/v1/orgs/${o}/support-grants`,
    body: (staffAuthUserId) => ({
      staffUserId: staffAuthUserId,
      expiresInSec: 900,
      reason: 'kill',
    }),
  },
];

/**
 * Spec SP3 tiêu chí 11 cho key và grant (§18.4): dòng và event cùng commit hoặc cùng mất. Điểm chờ: câu `INSERT` bảng nối
 * (`org_api_key_permissions` / `org_support_grant_permissions`) kiểm FK tới `permissions` bằng `FOR KEY SHARE`; test giữ
 * `FOR UPDATE` trên dòng `permissions` của `org.read` bằng kết nối owner (bảng global, `app_user` chỉ có `SELECT`). Khi đó
 * dòng `org_api_keys`/`org_support_grants` đã ghi (chưa commit), event chưa ghi. SIGKILL api → PgBouncer đóng connection
 * server → rollback.
 */
describe('api killed inside a delegation transaction (spec SP3 tiêu chí 11, phần 3D)', () => {
  const apis: AppProcess[] = [];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    for (const o of orgs) await o.dispose();
    await deleteSeededPrincipals(principals);
  });

  it.each(CASES)(
    '$name: SIGKILL while the scope insert waits → no row, no event; a fresh api succeeds exactly once',
    async (c) => {
      const owner = await seedUserPrincipal();
      const staff = await seedStaffPrincipal();
      principals.push(owner, staff);
      const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
      orgs.push(org);
      // FORCE RLS: bảng tenant đọc bằng app_user trong OrgScope (ownerQuery không có org context thì luôn thấy 0 dòng).
      const state = async () => ({
        rows: (
          await withAppClient((cl) =>
            inOrgTx(cl, org.orgId, () =>
              cl.query(`SELECT 1 FROM ${c.table} WHERE org_id = $1`, [
                org.orgId,
              ]),
            ),
          )
        ).rows.length,
        events: (
          await ownerQuery(
            'SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = $2',
            [org.orgId, c.event],
          )
        ).length,
      });
      const first = await startApi();
      apis.push(first);
      const { pg: p } = getInfra();
      const lock = new pg.Client({
        host: p.host,
        port: p.port,
        database: p.database,
        ...p.owner,
      });
      await lock.connect();
      let blocked: number[] = [];
      try {
        await lock.query('BEGIN');
        try {
          await lock.query(
            'SELECT 1 FROM permissions WHERE key = $1 FOR UPDATE',
            [LOCKED_PERMISSION],
          );
          const [{ pid } = { pid: -1 }] = (
            await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          ).rows;
          const pending = post(
            first.port,
            owner.bearer,
            c.path(org.orgId),
            c.body(staff.authUserId),
          ).then(
            (r) => r.status,
            (err: unknown) => err,
          );
          await until(async () => {
            blocked = (
              await ownerQuery<{ pid: number }>(
                'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
                [pid],
              )
            ).map((r) => r.pid);
            return blocked.length > 0;
          });
          // Chờ đúng ở câu nối: backend đã ghi bảng chính và bảng nối trong transaction, chưa chạm outbox. `pg_locks` thay
          // cho `pg_stat_activity.query` (owner không thấy text câu của backend app_user: `<insufficient privilege>`).
          const written = (
            await ownerQuery<{ relname: string }>(
              `SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
               WHERE l.pid = ANY($1::int[]) AND l.mode = 'RowExclusiveLock' AND l.granted AND c.relkind = 'r'`,
              [blocked],
            )
          ).map((r) => r.relname);
          expect(written).toEqual(expect.arrayContaining([c.table, c.bridge]));
          expect(written).not.toContain('outbox_events');
          const exited = exitCode(first.child);
          first.child.kill('SIGKILL');
          await exited;
          expect(await pending).toBeInstanceOf(Error);
          await lock.query('COMMIT');
        } catch (err) {
          await lock.query('ROLLBACK');
          throw err;
        }
      } finally {
        await lock.end();
      }
      // Chờ backend bị bỏ rơi kết thúc (PgBouncer đóng connection server của client đã chết → rollback).
      await until(
        async () =>
          (
            await ownerQuery(
              `SELECT 1 FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state <> 'idle'`,
              [blocked],
            )
          ).length === 0,
      );
      expect(await state()).toEqual({ rows: 0, events: 0 });
      const second = await startApi();
      apis.push(second);
      expect(
        (
          await post(
            second.port,
            owner.bearer,
            c.path(org.orgId),
            c.body(staff.authUserId),
          )
        ).status,
      ).toBe(201);
      expect(await state()).toEqual({ rows: 1, events: 1 });
    },
    120_000,
  );
});
