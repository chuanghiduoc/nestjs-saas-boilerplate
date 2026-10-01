import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const NAME = 'Killed mid-transaction';
const PROCESS_ENV: Record<string, string> = {
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
};

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
const rolesNamed = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(
      c,
      orgId,
      async () =>
        (await c.query('SELECT 1 FROM org_roles WHERE name = $1', [NAME])).rows
          .length,
    ),
  );
const createdEvents = (orgId: string) =>
  ownerQuery(
    `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.role.created'`,
    [orgId],
  );
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
const createRole = (port: number, p: SeededPrincipal, orgId: string) =>
  fetch(`http://127.0.0.1:${port}/v1/orgs/${orgId}/roles`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${p.bearer}`,
      'content-type': 'application/json',
      'idempotency-key': `kill-${orgId}-${Date.now()}`,
    },
    body: JSON.stringify({ name: NAME, permissions: ['org.read'] }),
  });

/**
 * Spec SP3 §1 tiêu chí 11 cho `tenancy.role.created`: test giữ `FOR UPDATE` trên dòng `permissions` của `org.read`; câu
 * chèn quyền của `RoleService.create` đứng chờ ở kiểm FK (`FOR KEY SHARE`) SAU khi dòng `org_roles` đã được ghi trong
 * cùng transaction và TRƯỚC khi event được ghi. SIGKILL api → PgBouncer đóng connection server → transaction rollback:
 * không role, không event. Api mới làm lại: đúng một role, đúng một event.
 */
describe('api killed inside the create-role transaction (spec SP3 tiêu chí 11, phần 3B)', () => {
  const apis: AppProcess[] = [];
  let owner: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  beforeAll(async () => {
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    await org?.dispose();
    if (owner) await deleteSeededPrincipals([owner]);
  });

  it('SIGKILL while the permission insert waits: no role, no event; a fresh api creates exactly one of each', async () => {
    if (!owner || !org) throw new Error('not seeded');
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
      await lock.query(
        `SELECT 1 FROM permissions WHERE key = 'org.read' FOR UPDATE`,
      );
      const [{ pid } = { pid: -1 }] = (
        await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows;
      const pending = createRole(first.port, owner, org.orgId).then(
        (r) => r.status,
        (err: unknown) => err,
      );
      // Backend của transaction tạo role đứng chờ khoá của test (kiểm FK trên dòng `permissions`), lọc theo pid của test.
      await until(async () => {
        blocked = (
          await ownerQuery<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          )
        ).map((r) => r.pid);
        return blocked.length > 0;
      });
      const exited = exitCode(first.child);
      first.child.kill('SIGKILL');
      await exited;
      expect(await pending).toBeInstanceOf(Error);
      await lock.query('COMMIT');
    } finally {
      await lock.end();
    }
    // Chờ backend bị bỏ rơi kết thúc (PgBouncer đóng connection server của client đã chết → rollback); nếu nó commit thì
    // dòng role xuất hiện và assert dưới đỏ, đúng là lỗi cần bắt.
    await until(
      async () =>
        (
          await ownerQuery(
            `SELECT 1 FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state <> 'idle'`,
            [blocked],
          )
        ).length === 0,
    );
    expect(await rolesNamed(org.orgId)).toBe(0);
    expect(await createdEvents(org.orgId)).toEqual([]);
    const second = await startApi();
    apis.push(second);
    expect((await createRole(second.port, owner, org.orgId)).status).toBe(201);
    expect(await rolesNamed(org.orgId)).toBe(1);
    expect(await createdEvents(org.orgId)).toHaveLength(1);
  }, 120_000);
});
