import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GrantorRecheck,
  type GrantorCheck,
} from '../../../src/modules/tenancy/application/grantor-recheck.js';
import { ownerQuery } from '../../support/identity-app.js';
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
  inOrgTx,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';
import {
  installPayrollPermission,
  permissionRowCount,
  removePayrollPermission,
} from './fixtures/payroll-permissions.js';

/** Có ở DB, KHÔNG catalogue nào nạp (không import `PayrollPermissionsModule`) → key orphan (R-X23). */
const ORPHAN = 'payroll.read';

/**
 * Final review 3C I-1: key orphan của role đích phải đi vào `assertCanBind` cả lúc TẠO lời mời/link (`InviteRole`) lẫn lúc
 * KIỂM LẠI người mời/người tạo khi chấp nhận/join (`GrantorRecheck`): role còn key orphan chỉ owner gán được (3B I-1).
 */
describe('orphan keys of the target role at create and at the grantor re-check (R-X23; final review 3C I-1)', () => {
  let app: INestApplication;
  let permissionRowsBefore: number;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  /** O owner, A admin (có `invitations.write`); `plain` = {org.read} mà A trội hẳn. */
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const plain = await seedCustomRole(org, {
      permissions: ['org.read'],
      name: `Plain ${v7()}`,
    });
    return { org, A, aMemberId: a.memberId, plain };
  };
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  /** Thêm key orphan vào role bằng SQL (API không cấp được key orphan). */
  const addOrphan = (org: SeededOrg, role: SeededRole) =>
    sql(
      org,
      `INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = $3`,
      [org.orgId, role.id, ORPHAN],
    );
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [aggregateId],
    );
  /** Kết quả lần kiểm lại gần nhất: link không mang lý do trong event, nên đọc thẳng kết quả của `GrantorRecheck`. */
  const recheckResults = () => {
    const spy = vi.spyOn(app.get(GrantorRecheck), 'check');
    return {
      last: async (): Promise<GrantorCheck | undefined> => {
        const r = spy.mock.results.at(-1);
        return r?.type === 'return' ? await r.value : undefined;
      },
      restore: () => spy.mockRestore(),
    };
  };

  beforeAll(async () => {
    permissionRowsBefore = await permissionRowCount();
    await installPayrollPermission();
    app = await startTenancyApp({
      env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await removePayrollPermission();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    expect(await permissionRowCount()).toBe(permissionRowsBefore);
  });

  it('create: an admin cannot invite to a custom role holding an orphan key → 403 escalation_denied', async () => {
    const c = await cast();
    const withOrphan = await seedCustomRole(c.org, {
      permissions: ['org.read', ORPHAN],
      name: `Orphan ${v7()}`,
    });
    const r = await authed(app, c.A)
      .post(`/v1/orgs/${c.org.orgId}/invitations`)
      .set('idempotency-key', `k-${v7()}`)
      .send({
        email: `orphan-${v7()}@example.test`,
        roleId: withOrphan.publicId,
      });
    expect([r.status, r.body.code]).toEqual([403, 'escalation_denied']);
  });
  it('accept: the role gained an orphan key after the admin invited → 409 invitation_invalidated { INVITER_NOT_DOMINANT }', async () => {
    const c = await cast();
    const invitee = await seedP();
    const inv = await seedInvitation(c.org, {
      email: invitee.email,
      roleId: c.plain.id,
      inviterMemberId: c.aMemberId,
    });
    await addOrphan(c.org, c.plain);
    const r = await acceptInvitation(app, invitee, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([409, 'invitation_invalidated']);
    expect(
      (await events(inv.publicId)).map((e) => [e.type, e.payload['reason']]),
    ).toEqual([['tenancy.invitation.invalidated', 'INVITER_NOT_DOMINANT']]);
  });
  it('join: the role gained an orphan key after the admin created the link → 409 invite_link_invalidated { INVITER_NOT_DOMINANT }', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, {
      roleId: c.plain.id,
      createdByMemberId: c.aMemberId,
    });
    await addOrphan(c.org, c.plain);
    const recheck = recheckResults();
    try {
      const r = await joinInviteLink(app, await seedP(), { token: link.token });
      expect([r.status, r.body.code]).toEqual([409, 'invite_link_invalidated']);
      expect(await recheck.last()).toEqual({
        ok: false,
        reason: 'INVITER_NOT_DOMINANT',
      });
    } finally {
      recheck.restore();
    }
  });
  it('join: the link creator was demoted to MEMBER → 409 invite_link_invalidated { INVITER_LACKS_GATE }', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, {
      roleId: c.plain.id,
      createdByMemberId: c.aMemberId,
    });
    await sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [
      c.org.roles.MEMBER.id,
      c.aMemberId,
    ]);
    const recheck = recheckResults();
    try {
      const r = await joinInviteLink(app, await seedP(), { token: link.token });
      expect([r.status, r.body.code]).toEqual([409, 'invite_link_invalidated']);
      expect(await recheck.last()).toEqual({
        ok: false,
        reason: 'INVITER_LACKS_GATE',
      });
    } finally {
      recheck.restore();
    }
  });
});
