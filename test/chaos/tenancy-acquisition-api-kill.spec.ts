import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../support/app-process.js';
import { baseTestEnv } from '../support/env.js';
import { seedOrgEntitlement } from '../support/entitlements-seed.js';
import { ownerQuery } from '../support/identity-app.js';
import { exitCode } from '../support/spawn-worker.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import {
  inOrgTx,
  seedInvitation,
  seedOrg,
  withAppClient,
  type SeededInvitation,
  type SeededOrg,
} from '../support/tenancy-seed.js';

const WAIT_MS = 60_000;
const API_ENTRY = 'test/support/api-entry.ts';
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
const accept = (port: number, p: SeededPrincipal, token: string) =>
  fetch(`http://127.0.0.1:${port}/v1/invitations/accept`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${p.bearer}`,
      'content-type': 'application/json',
      'idempotency-key': `kill-${Date.now()}`,
    },
    body: JSON.stringify({ token }),
  });

/**
 * Spec SP3 §1 tiêu chí 11 cho chấp nhận lời mời (§18.4): test giữ `FOR UPDATE` trên dòng role MEMBER của org (bằng
 * `app_user` trong OrgScope: bảng FORCE RLS). Transaction chấp nhận đứng chờ ở kiểm FK `FOR KEY SHARE` của câu `INSERT
 * org_members` — SAU khi đã khoá org, upsert `tenancy_users`, khoá lời mời và kiểm lại người mời — TRƯỚC CAS ACCEPTED và
 * event. SIGKILL api → PgBouncer đóng connection server → rollback: lời mời PENDING, không member, không event.
 */
describe('api killed inside the accept transaction (spec SP3 tiêu chí 11, phần 3C)', () => {
  const apis: AppProcess[] = [];
  let owner: SeededPrincipal | undefined;
  let invitee: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  let inv: SeededInvitation | undefined;
  beforeAll(async () => {
    owner = await seedUserPrincipal();
    invitee = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    // App con là composition thật: có entitlements nên `MemberAdmission` đọc `tenancy.seats` qua adapter ghế, adapter fail
    // closed (503) với org thiếu dòng `org_entitlements` (spec SP4 §9.6). Org thật có dòng từ participant tạo org; org
    // seed phải chèn tường minh.
    await seedOrgEntitlement(org.orgId, 'free');
    inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
  });
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    await org?.dispose();
    if (owner && invitee) await deleteSeededPrincipals([owner, invitee]);
  });

  it('SIGKILL while the member insert waits: invitation PENDING, no member, no event; a fresh api accepts exactly once', async () => {
    if (!owner || !invitee || !org || !inv) throw new Error('not seeded');
    // Hằng cục bộ: thu hẹp kiểu của biến `let` không đi qua các closure bên dưới.
    const p = invitee;
    const o = org;
    const invId = inv.id;
    const token = inv.token;
    const state = async () => ({
      status: (
        await withAppClient((c) =>
          inOrgTx(c, o.orgId, () =>
            c.query('SELECT status FROM org_invitations WHERE id = $1', [
              invId,
            ]),
          ),
        )
      ).rows[0]?.status,
      members: (
        await withAppClient((c) =>
          inOrgTx(c, o.orgId, () =>
            c.query(
              'SELECT 1 FROM org_members m JOIN tenancy_users u ON u.id = m.user_id WHERE u.auth_user_id = $1',
              [p.authUserId],
            ),
          ),
        )
      ).rows.length,
      events: (
        await ownerQuery(
          `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type IN ('tenancy.invitation.accepted', 'tenancy.member.added')`,
          [o.orgId],
        )
      ).length,
    });
    const first = await startApi();
    apis.push(first);
    let blocked: number[] = [];
    await withAppClient(async (lock) => {
      await lock.query('BEGIN');
      try {
        await lock.query(`SELECT set_config('app.org_id', $1, true)`, [
          o.orgId,
        ]);
        await lock.query('SELECT 1 FROM org_roles WHERE id = $1 FOR UPDATE', [
          o.roles.MEMBER.id,
        ]);
        const [{ pid } = { pid: -1 }] = (
          await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows;
        const pending = accept(first.port, p, token).then(
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
        const exited = exitCode(first.child);
        first.child.kill('SIGKILL');
        await exited;
        expect(await pending).toBeInstanceOf(Error);
        await lock.query('COMMIT');
      } catch (err) {
        await lock.query('ROLLBACK');
        throw err;
      }
    });
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
    expect(await state()).toEqual({ status: 'PENDING', members: 0, events: 0 });
    const second = await startApi();
    apis.push(second);
    expect((await accept(second.port, p, token)).status).toBe(201);
    expect(await state()).toEqual({
      status: 'ACCEPTED',
      members: 1,
      events: 2,
    });
  }, 120_000);
});
