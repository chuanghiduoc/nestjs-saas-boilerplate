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
const BEFORE = 'Before api kill';
const AFTER = 'After api kill';
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
/** `organizations` là FORCE RLS: đọc bằng `app_user` trong OrgScope của org. */
const orgName = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(
      c,
      orgId,
      async () =>
        (
          await c.query<{ name: string }>(
            'SELECT name FROM organizations WHERE id = $1',
            [orgId],
          )
        ).rows[0]?.name,
    ),
  );
const updatedEvents = (orgId: string) =>
  ownerQuery(
    `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.updated'`,
    [orgId],
  );
/** Có backend đang bị CHÍNH `holderPid` chặn (không đếm lock chờ của cả cluster). */
const blockedBy = async (holderPid: number): Promise<boolean> =>
  (
    await ownerQuery(
      'SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
      [holderPid],
    )
  ).length > 0;
const rename = (
  port: number,
  p: SeededPrincipal,
  orgId: string,
  name: string,
) =>
  fetch(`http://127.0.0.1:${port}/v1/orgs/${orgId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${p.bearer}`,
      'content-type': 'application/json',
      'if-match': '*',
    },
    body: JSON.stringify({ name }),
  });
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

/**
 * Spec SP3 §1 tiêu chí 11 (không event mồ côi, không thay đổi thiếu event): process api bị SIGKILL khi `PATCH
 * /v1/orgs/{id}` đã qua middleware + guard và đang ở TRONG transaction của mutation (đứng chờ khoá org mà test giữ).
 * Postgres rollback phần của nó (PgBouncer đóng connection server của client đã chết); thay đổi và event outbox cùng
 * transaction nên cùng mất. Một api mới làm lại đúng mutation đó: đúng một thay đổi, đúng một event.
 */
describe('api killed between the handler and the commit of a tenancy mutation (spec SP3 §1 criterion 11)', () => {
  const apis: AppProcess[] = [];
  let owner: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  beforeAll(async () => {
    owner = await seedUserPrincipal();
    org = await seedOrg({
      owner: { authUserId: owner.authUserId },
      name: BEFORE,
    });
  });
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    await org?.dispose();
    if (owner) await deleteSeededPrincipals([owner]);
  });

  it('SIGKILL while the rename waits on the org lock: no rename, no orphan event; a fresh api then renames with exactly one event', async () => {
    if (!owner || !org) throw new Error('not seeded');
    const first = await startApi();
    apis.push(first);
    const { pg: p } = getInfra();
    const holder = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.app,
    });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [
        org.orgId,
      ]);
      await holder.query(
        'SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE',
        [org.orgId],
      );
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]?.pid;
      if (holderPid === undefined) throw new Error('no backend pid');
      // Không bao giờ có response: process chết khi request còn trong transaction (fetch reject khi socket đóng).
      const pending = rename(first.port, owner, org.orgId, AFTER).then(
        (r) => r.status,
        (err: unknown) => err,
      );
      // `OrgService.rename` đã mở transaction và đứng ở `lockCurrent()` (FOR NO KEY UPDATE) chờ khoá của test.
      await until(() => blockedBy(holderPid));
      const exited = exitCode(first.child);
      first.child.kill('SIGKILL');
      await exited;
      expect(await pending).toBeInstanceOf(Error);
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    expect(await orgName(org.orgId)).toBe(BEFORE);
    expect(await updatedEvents(org.orgId)).toEqual([]);

    const second = await startApi();
    apis.push(second);
    expect((await rename(second.port, owner, org.orgId, AFTER)).status).toBe(
      200,
    );
    expect(await orgName(org.orgId)).toBe(AFTER);
    expect(await updatedEvents(org.orgId)).toHaveLength(1);
  });
});
