import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import {
  acceptInvitation,
  joinInviteLink,
} from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  deleteTenancyUsersOf,
  inOrgTx,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ROUNDS = 5;
const PENDING_CAP = 3;
const LINK_CAP = 2;
/** Dưới `idle_in_transaction_session_timeout` (10 s) của DB test. */
const HOLD_PAST_EXPIRY_MS = 4_000;
const EXPIRES_IN_SEC = 2;

describe('3C races on the org lock (spec SP3 §17; tiêu chí 6, 7; X-8, X-11, O-12)', () => {
  let app: INestApplication;
  let admin: SeededPrincipal;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP();
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const memberCount = async (org: SeededOrg) =>
    Number(
      (await sql(org, 'SELECT count(*)::int AS n FROM org_members')).rows[0]?.n,
    );
  const invite = (
    p: SeededPrincipal,
    org: SeededOrg,
    email: string,
    roleId: string,
  ) =>
    authed(app, p)
      .post(`/v1/orgs/${org.orgId}/invitations`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ email, roleId });
  const createLink = (p: SeededPrincipal, org: SeededOrg, roleId: string) =>
    authed(app, p)
      .post(`/v1/orgs/${org.orgId}/invite-links`)
      .send({
        roleId,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
  /** T-29 / X-11: giữ khoá dòng org qua mốc hết hạn trong khi `fire` đứng chờ ở bước khoá org, rồi thả. */
  const holdOrgLockPast = <T>(
    org: SeededOrg,
    untilMs: number,
    fire: () => Promise<T>,
  ) =>
    withAppClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query(`SELECT set_config('app.org_id', $1, true)`, [
          org.orgId,
        ]);
        await holder.query(
          'SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE',
          [org.orgId],
        );
        const [{ pid } = { pid: -1 }] = (
          await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows;
        const pending = fire();
        pending.catch(() => undefined);
        await vi.waitFor(
          async () =>
            expect(
              (
                await ownerQuery(
                  'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
                  [pid],
                )
              ).length,
            ).toBe(1),
          { timeout: 3_000, interval: 20 },
        );
        const wait = untilMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await holder.query('COMMIT');
        return await pending;
      } catch (err) {
        await holder.query('ROLLBACK');
        throw err;
      }
    });

  beforeAll(async () => {
    app = await startTenancyApp({
      env: {
        THROTTLE_DEFAULT_LIMIT: '100000',
        TENANCY_MAX_PENDING_INVITATIONS_PER_ORG: String(PENDING_CAP),
        TENANCY_MAX_ACTIVE_INVITE_LINKS_PER_ORG: String(LINK_CAP),
      },
    });
    admin = await seedP({ role: 'admin' });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`tiêu chí 6 / T-2: 4 parallel accepts of one invitation × ${ROUNDS} → exactly one 201, the rest the uniform 404; one member, one accepted event`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const p = await seedP();
      const inv = await seedInvitation(c.org, {
        email: p.email,
        roleId: c.org.roles.MEMBER.id,
        inviterMemberId: c.a.memberId,
      });
      const before = await memberCount(c.org);
      const rs = await raceOnOrgLock(c.org.orgId, 4, () =>
        Promise.all(
          Array.from({ length: 4 }, () =>
            acceptInvitation(app, p, { token: inv.token }),
          ),
        ),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([201, 404, 404, 404]);
      expect(await memberCount(c.org)).toBe(before + 1);
      expect(
        await ownerQuery(
          `SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND type = 'tenancy.invitation.accepted'`,
          [inv.publicId],
        ),
      ).toHaveLength(1);
    }
  });
  it('tiêu chí 7 / T-5: a link with maxUses = 3 and 6 parallel joins → exactly 3 × 201 and 3 × 404; use_count = 3', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, {
      roleId: c.org.roles.MEMBER.id,
      createdByMemberId: c.a.memberId,
      maxUses: 3,
    });
    const joiners = await Promise.all(Array.from({ length: 6 }, () => seedP()));
    const before = await memberCount(c.org);
    const rs = await raceOnOrgLock(c.org.orgId, 6, () =>
      Promise.all(
        joiners.map((p) => joinInviteLink(app, p, { token: link.token })),
      ),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([
      201, 201, 201, 404, 404, 404,
    ]);
    expect(
      (
        await sql(
          c.org,
          'SELECT use_count FROM org_invite_links WHERE id = $1',
          [link.id],
        )
      ).rows,
    ).toEqual([{ use_count: 3 }]);
    expect(await memberCount(c.org)).toBe(before + 3);
  });
  it('T-3: an invitation and a link of the same org for the same user in parallel → one 201, one 409 already_member; the loser leaves no trace', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const p = await seedP();
      const inv = await seedInvitation(c.org, {
        email: p.email,
        roleId: c.org.roles.MEMBER.id,
        inviterMemberId: c.a.memberId,
      });
      const link = await seedInviteLink(c.org, {
        roleId: c.org.roles.MEMBER.id,
        createdByMemberId: c.a.memberId,
        maxUses: 2,
      });
      const [a, j] = await raceOnOrgLock(c.org.orgId, 2, () =>
        Promise.all([
          acceptInvitation(app, p, { token: inv.token }),
          joinInviteLink(app, p, { token: link.token }),
        ]),
      );
      expect([a.status, j.status].sort()).toEqual([201, 409]);
      const invStatus = (
        await sql(c.org, 'SELECT status FROM org_invitations WHERE id = $1', [
          inv.id,
        ])
      ).rows[0]?.status;
      const uses = (
        await sql(
          c.org,
          'SELECT use_count FROM org_invite_links WHERE id = $1',
          [link.id],
        )
      ).rows[0]?.use_count;
      expect([invStatus, uses]).toEqual(
        a.status === 201 ? ['ACCEPTED', 0] : ['PENDING', 1],
      );
    }
  });
  it('T-4: two admins invite the same email in parallel → one 201, one 409 invitation_pending_exists', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const email = `t4-${v7()}@example.test`;
      const rs = await raceOnOrgLock(c.org.orgId, 2, () =>
        Promise.all([
          invite(c.O, c.org, email, c.org.roles.MEMBER.publicId),
          invite(c.A, c.org, email, c.org.roles.MEMBER.publicId),
        ]),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(rs.find((r) => r.status === 409)?.body.code).toBe(
        'invitation_pending_exists',
      );
    }
  });
  it('T-11: the per-org caps hold under parallel creates (invitations and links)', async () => {
    const c = await cast();
    const rs = await raceOnOrgLock(c.org.orgId, 6, () =>
      Promise.all(
        Array.from({ length: 6 }, () =>
          invite(
            c.A,
            c.org,
            `t11-${v7()}@example.test`,
            c.org.roles.MEMBER.publicId,
          ),
        ),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(PENDING_CAP);
    expect(rs.filter((r) => r.status === 422).map((r) => r.body.code)).toEqual(
      Array(6 - PENDING_CAP).fill('pending_invitations_limit'),
    );
    const ls = await raceOnOrgLock(c.org.orgId, 5, () =>
      Promise.all(
        Array.from({ length: 5 }, () =>
          createLink(c.A, c.org, c.org.roles.MEMBER.publicId),
        ),
      ),
    );
    expect(ls.filter((r) => r.status === 201)).toHaveLength(LINK_CAP);
    expect(ls.filter((r) => r.status === 422).map((r) => r.body.code)).toEqual(
      Array(5 - LINK_CAP).fill('invite_links_limit'),
    );
  });
  it('T-9 (invitation/link part): deleting a role races creating an invitation or a link with it → never both succeed, never a dangling role', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      for (const create of [
        (roleId: string) =>
          invite(c.O, c.org, `t9-${v7()}@example.test`, roleId),
        (roleId: string) => createLink(c.O, c.org, roleId),
      ]) {
        const role = await seedCustomRole(c.org, {
          permissions: ROLE_SET_C0,
          name: `T9 ${v7()}`,
        });
        const [made, del] = await raceOnOrgLock(c.org.orgId, 2, () =>
          Promise.all([
            create(role.publicId),
            authed(app, c.O).delete(
              `/v1/orgs/${c.org.orgId}/roles/${role.publicId}`,
            ),
          ]),
        );
        const pair = `${made.status}/${del.status}`;
        expect(['201/409', '422/204'], pair).toContain(pair);
        if (del.status === 409) expect(del.body.code).toBe('role_in_use');
        if (made.status === 422)
          expect(made.body.code).toBe('validation_failed');
      }
    }
  });
  it('T-16: accept ∥ decline ∥ cancel of one transfer → exactly one wins, the others 409 ownership_transfer_not_pending', async () => {
    const c = await cast();
    for (let i = 0; i < ROUNDS; i++) {
      const t = await seedTransfer(c.org, {
        fromMemberId: c.org.owner.memberId,
        toMemberId: c.m.memberId,
      });
      const base = `/v1/orgs/${c.org.orgId}/ownership-transfers/${t.publicId}`;
      const rs = await raceOnOrgLock(c.org.orgId, 3, () =>
        Promise.all([
          authed(app, c.M)
            .post(`${base}/accept`)
            .set('idempotency-key', `k-${v7()}`)
            .send({}),
          authed(app, c.M)
            .post(`${base}/decline`)
            .set('idempotency-key', `k-${v7()}`)
            .send({}),
          authed(app, c.O).delete(base),
        ]),
      );
      expect(
        rs.filter((r) => r.status === 200 || r.status === 204),
      ).toHaveLength(1);
      expect(
        rs.filter((r) => r.status === 409).map((r) => r.body.code),
      ).toEqual([
        'ownership_transfer_not_pending',
        'ownership_transfer_not_pending',
      ]);
      // Nếu accept thắng, M thành owner: hạ M về MEMBER bằng SQL cho vòng sau (O vẫn là owner).
      await sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [
        c.org.roles.MEMBER.id,
        c.m.memberId,
      ]);
    }
  });
  it('T-21: two admins revoke one invitation → one 204, one 409 invitation_not_pending', async () => {
    const c = await cast();
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await seedInvitation(c.org, {
        email: `t21-${v7()}@example.test`,
        roleId: c.org.roles.MEMBER.id,
        inviterMemberId: c.a.memberId,
      });
      const url = `/v1/orgs/${c.org.orgId}/invitations/${inv.publicId}`;
      const rs = await raceOnOrgLock(c.org.orgId, 2, () =>
        Promise.all([
          authed(app, c.O).delete(url),
          authed(app, c.A).delete(url),
        ]),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([204, 409]);
    }
  });
  it('T-27 / X-8: accepting races a soft delete → (201, ACCEPTED) or (404, REVOKED); the soft delete always wins its own 204', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const p = await seedP();
      const inv = await seedInvitation(c.org, {
        email: p.email,
        roleId: c.org.roles.MEMBER.id,
        inviterMemberId: c.a.memberId,
      });
      const [acc, del] = await raceOnOrgLock(c.org.orgId, 2, () =>
        Promise.all([
          acceptInvitation(app, p, { token: inv.token }),
          authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}`),
        ]),
      );
      expect(del.status).toBe(204);
      const status = (
        await sql(c.org, 'SELECT status FROM org_invitations WHERE id = $1', [
          inv.id,
        ])
      ).rows[0]?.status;
      expect([acc.status, status]).toEqual(
        acc.status === 201 ? [201, 'ACCEPTED'] : [404, 'REVOKED'],
      );
    }
  });
  it('T-29 / X-11: waiting on the org lock past expires_at → accept 404, join 404, transfer accept 409; rows read EXPIRED where stored', async () => {
    const c = await cast();
    const p = await seedP();
    const inv = await seedInvitation(c.org, {
      email: p.email,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.a.memberId,
      expiresInSec: EXPIRES_IN_SEC,
    });
    const acc = await holdOrgLockPast(
      c.org,
      Date.now() + HOLD_PAST_EXPIRY_MS,
      () => acceptInvitation(app, p, { token: inv.token }),
    );
    expect([acc.status, acc.body.code]).toEqual([404, 'invitation_not_found']);
    expect(
      (
        await sql(c.org, 'SELECT status FROM org_invitations WHERE id = $1', [
          inv.id,
        ])
      ).rows,
    ).toEqual([{ status: 'EXPIRED' }]);
    const link = await seedInviteLink(c.org, {
      roleId: c.org.roles.MEMBER.id,
      createdByMemberId: c.a.memberId,
      expiresInSec: EXPIRES_IN_SEC,
    });
    const join = await holdOrgLockPast(
      c.org,
      Date.now() + HOLD_PAST_EXPIRY_MS,
      () => joinInviteLink(app, p, { token: link.token }),
    );
    expect([join.status, join.body.code]).toEqual([
      404,
      'invite_link_not_found',
    ]);
    expect(
      (
        await sql(
          c.org,
          'SELECT use_count FROM org_invite_links WHERE id = $1',
          [link.id],
        )
      ).rows,
    ).toEqual([{ use_count: 0 }]);
    const t = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.m.memberId,
      expiresInSec: EXPIRES_IN_SEC,
    });
    const ta = await holdOrgLockPast(
      c.org,
      Date.now() + HOLD_PAST_EXPIRY_MS,
      () =>
        authed(app, c.M)
          .post(
            `/v1/orgs/${c.org.orgId}/ownership-transfers/${t.publicId}/accept`,
          )
          .set('idempotency-key', `k-${v7()}`)
          .send({}),
    );
    expect([ta.status, ta.body.code]).toEqual([
      409,
      'ownership_transfer_not_pending',
    ]);
    expect(
      (
        await sql(
          c.org,
          'SELECT status FROM org_ownership_transfers WHERE id = $1',
          [t.id],
        )
      ).rows,
    ).toEqual([{ status: 'EXPIRED' }]);
  });
  it(`T-18 / O-12: account deletion races accepting an invitation × ${ROUNDS} → never a 5xx, never an orphan; a 409 keeps the account`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const u = await seedP();
      const inv = await seedInvitation(c.org, {
        email: u.email,
        roleId: c.org.roles.MEMBER.id,
        inviterMemberId: c.a.memberId,
      });
      const [acc, del] = await Promise.all([
        acceptInvitation(app, u, { token: inv.token }),
        authed(app, admin)
          .post('/api/auth/admin/remove-user')
          .set('origin', 'http://localhost:3000')
          .send({ userId: u.authUserId }),
      ]);
      expect(acc.status).toBeLessThan(500);
      expect(del.status).toBeLessThan(500);
      const tenancyRows = await ownerQuery(
        'SELECT 1 FROM tenancy_users WHERE auth_user_id = $1',
        [u.authUserId],
      );
      const authRows = await ownerQuery(
        'SELECT 1 FROM auth."user" WHERE id = $1',
        [u.authUserId],
      );
      if (del.status === 200)
        expect([tenancyRows.length, authRows.length]).toEqual([0, 0]);
      else {
        expect([del.status, del.body.code]).toEqual([
          409,
          'user_deletion_blocked',
        ]);
        expect(authRows).toHaveLength(1);
      }
    }
  });
});
