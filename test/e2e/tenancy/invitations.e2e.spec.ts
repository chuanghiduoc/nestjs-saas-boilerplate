import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import {
  acceptInvitation,
  previewToken,
  problemCore,
  tokenFromMail,
} from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  adminKeys,
  inOrgTx,
  newToken,
  roleSetC1,
  seedCustomRole,
  seedInvitation,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';
import {
  PayrollPermissionsModule,
  installPayrollPermission,
  removePayrollPermission,
} from './fixtures/payroll-permissions.js';

const PENDING_CAP = 3;
const SUBJECT = /You're invited to join/;

describe('email invitations (spec SP3 §9.1, §12; §18.3 B-10, B-12, B-13, B-16, B-20, B-22–B-24; Review Focus 1–3)', () => {
  let app: INestApplication;
  /** Tính từ catalogue gộp lúc chạy (R-X24). */
  let ADMIN_KEYS: string[];
  let C1: string[];
  const mail = mailpitFromInfra();
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** O owner, A admin, Xp giữ X = ADMIN ∪ {payroll.read}; c1 = C1, vPrime ≡ ADMIN (owner tạo, chưa ai giữ). */
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({
      owner: { authUserId: O.authUserId },
      name: 'Acme',
    });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const c1 = await seedCustomRole(org, {
      permissions: C1,
      name: `C1 ${v7()}`,
    });
    const vPrime = await seedCustomRole(org, {
      permissions: ADMIN_KEYS,
      name: `V' ${v7()}`,
    });
    const x = await seedCustomRole(org, {
      permissions: [...ADMIN_KEYS, 'payroll.read'],
      name: `X ${v7()}`,
    });
    const Xp = await seedP();
    await seedMemberInRole(org, x, { authUserId: Xp.authUserId });
    return { org, O, A, aMemberId: a.memberId, c1, vPrime, Xp };
  };
  const invite = (p: SeededPrincipal, org: SeededOrg, body: object) =>
    authed(app, p)
      .post(`/v1/orgs/${org.orgId}/invitations`)
      .set('idempotency-key', `k-${v7()}`)
      .send(body);
  const list = (p: SeededPrincipal, org: SeededOrg) =>
    authed(app, p).get(`/v1/orgs/${org.orgId}/invitations?pageSize=100`);
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [aggregateId],
    );
  const statusOf = async (org: SeededOrg, invitationId: string) =>
    (
      await sql(org, 'SELECT status FROM org_invitations WHERE id = $1', [
        invitationId,
      ])
    ).rows[0]?.status;
  const membersOf = async (org: SeededOrg, p: SeededPrincipal) =>
    (
      await sql(
        org,
        'SELECT 1 FROM org_members m JOIN tenancy_users u ON u.id = m.user_id WHERE u.auth_user_id = $1',
        [p.authUserId],
      )
    ).rows.length;

  beforeAll(async () => {
    await installPayrollPermission();
    app = await startTenancyApp({
      extraImports: [PayrollPermissionsModule],
      env: {
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
        HTTP_TRUST_PROXY: 'loopback',
        TENANCY_MAX_PENDING_INVITATIONS_PER_ORG: String(PENDING_CAP),
      },
    });
    const merged = app.get(PermissionCatalogueRegistry).merged();
    ADMIN_KEYS = adminKeys(merged);
    C1 = roleSetC1(merged);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await removePayrollPermission();
    vi.unstubAllEnvs();
  });

  it('create → 201 + Location, no token in the body, one email with #token=; preview; accept → 201 member; the token is single-use', async () => {
    const c = await cast();
    const invitee = await seedP();
    const after = await mail.now();
    const created = await invite(c.A, c.org, {
      email: invitee.email,
      roleId: c.c1.publicId,
    });
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(
      `/v1/orgs/${c.org.orgId}/invitations/${created.body.id}`,
    );
    expect(created.body).toMatchObject({
      email: invitee.email,
      status: 'PENDING',
      role: { id: c.c1.publicId, systemKey: null },
      resolvedAt: null,
    });
    expect(JSON.stringify(created.body)).not.toMatch(/token/i);
    const token = await tokenFromMail(mail, invitee.email, SUBJECT, after);
    const preview = await previewToken(app, 'invitations', { token });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({
      orgName: 'Acme',
      roleName: c.c1.name,
      expiresAt: created.body.expiresAt,
    });
    const accepted = await acceptInvitation(app, invitee, { token });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.location).toBe(
      `/v1/orgs/${c.org.orgId}/members/${accepted.body.id}`,
    );
    expect(accepted.body).toMatchObject({
      role: { id: c.c1.publicId },
      email: invitee.email,
    });
    expect((await events(created.body.id)).map((e) => e.type)).toEqual([
      'tenancy.invitation.created',
      'tenancy.invitation.accepted',
    ]);
    expect(
      (await events(accepted.body.id)).map((e) => [
        e.type,
        e.payload['source'],
        e.payload['invitationId'],
      ]),
    ).toEqual([['tenancy.member.added', 'INVITATION', created.body.id]]);
    const again = await acceptInvitation(app, await seedP(), { token });
    expect([again.status, again.body.code]).toEqual([
      404,
      'invitation_not_found',
    ]);
    expect(
      (await list(c.A, c.org)).body.data.find(
        (i: { id: string }) => i.id === created.body.id,
      ),
    ).toMatchObject({ status: 'ACCEPTED' });
  });
  it('Review Focus 1: the invited email is normalised and matched case-insensitively; a real mismatch never echoes the invited address', async () => {
    const c = await cast();
    const invitee = await seedP();
    const padded = ` ${invitee.email.toUpperCase()} `;
    const created = await invite(c.A, c.org, {
      email: padded,
      roleId: c.org.roles.MEMBER.publicId,
    });
    expect([created.status, created.body.email]).toEqual([201, invitee.email]);
    const stranger = await seedP();
    const other = await seedInvitation(c.org, {
      email: `other-${v7()}@example.test`,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.aMemberId,
    });
    const mismatch = await acceptInvitation(app, stranger, {
      token: other.token,
    });
    expect([mismatch.status, mismatch.body.code]).toEqual([
      403,
      'invitation_email_mismatch',
    ]);
    expect(JSON.stringify(mismatch.body)).not.toContain('other-');
    expect(await statusOf(c.org, other.id)).toBe('PENDING');
    for (const email of [
      'not-an-email',
      'a@',
      `${'a'.repeat(250)}@example.test`,
    ])
      expect(
        (
          await invite(c.A, c.org, {
            email,
            roleId: c.org.roles.MEMBER.publicId,
          })
        ).body.code,
      ).toBe('validation_failed');
  });
  it('Review Focus 2: accepting while already a member is 409 already_member and leaves the invitation pending', async () => {
    const c = await cast();
    const inv = await seedInvitation(c.org, {
      email: c.A.email,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.org.owner.memberId,
    });
    const r = await acceptInvitation(app, c.A, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([409, 'already_member']);
    expect(await statusOf(c.org, inv.id)).toBe('PENDING');
    expect(await events(inv.publicId)).toEqual([]);
  });
  it('Review Focus 3: garbage tokens are 422 or the uniform 404, never 500', async () => {
    const p = await seedP();
    const bodies422: unknown[] = [
      {},
      { token: '' },
      { token: 'x'.repeat(10_000) },
      { token: 'abc$%' },
      { token: 42 },
      { token: 'abc', extra: 1 },
      null,
    ];
    for (const body of bodies422) {
      expect(
        (await previewToken(app, 'invitations', body)).status,
        JSON.stringify(body),
      ).toBe(422);
      expect(
        (await acceptInvitation(app, p, body)).status,
        JSON.stringify(body),
      ).toBe(422);
    }
    for (const token of [newToken(), 'a', 'A'.repeat(128)]) {
      expect(
        (await previewToken(app, 'invitations', { token })).body.code,
      ).toBe('invitation_not_found');
      expect((await acceptInvitation(app, p, { token })).body.code).toBe(
        'invitation_not_found',
      );
    }
  });
  it('unknown, expired, used, revoked and soft-deleted-org tokens give one identical 404 at preview and accept', async () => {
    const c = await cast();
    const p = await seedP();
    const base = {
      email: p.email,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.aMemberId,
    };
    const expired = await seedInvitation(c.org, { ...base, expiresInSec: -60 });
    const revoked = await seedInvitation(c.org, {
      ...base,
      email: `r-${v7()}@example.test`,
    });
    expect(
      (
        await authed(app, c.A).delete(
          `/v1/orgs/${c.org.orgId}/invitations/${revoked.publicId}`,
        )
      ).status,
    ).toBe(204);
    const deletedOrg = await cast();
    const inDeleted = await seedInvitation(deletedOrg.org, {
      email: p.email,
      roleId: deletedOrg.org.roles.MEMBER.id,
      inviterMemberId: deletedOrg.aMemberId,
    });
    expect(
      (
        await authed(app, deletedOrg.O).delete(
          `/v1/orgs/${deletedOrg.org.orgId}`,
        )
      ).status,
    ).toBe(204);
    const tokens = [newToken(), expired.token, revoked.token, inDeleted.token];
    const previews = await Promise.all(
      tokens.map((token) => previewToken(app, 'invitations', { token })),
    );
    const accepts = [];
    for (const token of tokens)
      accepts.push(await acceptInvitation(app, p, { token }));
    for (const r of [...previews, ...accepts]) expect(r.status).toBe(404);
    expect(
      new Set(
        [...previews, ...accepts].map((r) =>
          JSON.stringify(problemCore(r.body)),
        ),
      ).size,
    ).toBe(1);
    // Chạm sau hạn ghi EXPIRED (không event, §14.1); dòng còn lại đã thu hồi không đổi.
    expect(await statusOf(c.org, expired.id)).toBe('EXPIRED');
    expect((await events(expired.publicId)).map((e) => e.type)).toEqual([]);
  });
  it('revoke: 204 + one tenancy.invitation.revoked; again → 409 invitation_not_pending; a lapsed one → 409 and EXPIRED without an event', async () => {
    const c = await cast();
    const inv = await seedInvitation(c.org, {
      email: `rv-${v7()}@example.test`,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.aMemberId,
    });
    const url = `/v1/orgs/${c.org.orgId}/invitations/${inv.publicId}`;
    expect((await authed(app, c.A).delete(url)).status).toBe(204);
    expect((await authed(app, c.A).delete(url)).body.code).toBe(
      'invitation_not_pending',
    );
    expect((await events(inv.publicId)).map((e) => e.type)).toEqual([
      'tenancy.invitation.revoked',
    ]);
    const lapsed = await seedInvitation(c.org, {
      email: `lp-${v7()}@example.test`,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.aMemberId,
      expiresInSec: -60,
    });
    expect(
      (
        await authed(app, c.A).delete(
          `/v1/orgs/${c.org.orgId}/invitations/${lapsed.publicId}`,
        )
      ).body.code,
    ).toBe('invitation_not_pending');
    expect(await statusOf(c.org, lapsed.id)).toBe('EXPIRED');
    expect(await events(lapsed.publicId)).toEqual([]);
    expect(
      (
        await authed(app, c.A).delete(
          `/v1/orgs/${c.org.orgId}/invitations/not-a-uuid`,
        )
      ).status,
    ).toBe(404);
  });
  it('T-4 / T-11: a second pending invitation for the same email is 409; the per-org cap counts only pending, unexpired invitations', async () => {
    const c = await cast();
    const email = `dup-${v7()}@example.test`;
    await seedInvitation(c.org, {
      email,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.aMemberId,
      expiresInSec: -60,
    });
    expect(
      (await invite(c.A, c.org, { email, roleId: c.org.roles.MEMBER.publicId }))
        .status,
    ).toBe(201); // lapsed → EXPIRED trước INSERT
    expect(
      (await invite(c.A, c.org, { email, roleId: c.org.roles.MEMBER.publicId }))
        .body.code,
    ).toBe('invitation_pending_exists');
    await seedInvitation(c.org, {
      email: `done-${v7()}@example.test`,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.aMemberId,
      status: 'REVOKED',
    });
    for (let i = 1; i < PENDING_CAP; i++)
      expect(
        (
          await invite(c.A, c.org, {
            email: `cap-${i}-${v7()}@example.test`,
            roleId: c.org.roles.MEMBER.publicId,
          })
        ).status,
      ).toBe(201);
    const over = await invite(c.A, c.org, {
      email: `over-${v7()}@example.test`,
      roleId: c.org.roles.MEMBER.publicId,
    });
    expect([over.status, over.body.code]).toEqual([
      422,
      'pending_invitations_limit',
    ]);
  });
  it('B-16 / B-22 / B-23 / B-10 at creation: OWNER is never invitable; X cannot invite with ADMIN or V′; a role the actor does not strictly dominate is refused', async () => {
    const c = await cast();
    const email = () => `b-${v7()}@example.test`;
    expect(
      (
        await invite(c.O, c.org, {
          email: email(),
          roleId: c.org.roles.OWNER.publicId,
        })
      ).body.code,
    ).toBe('owner_not_invitable');
    expect(
      (
        await invite(c.A, c.org, {
          email: email(),
          roleId: c.org.roles.OWNER.publicId,
        })
      ).body.code,
    ).toBe('owner_not_invitable');
    expect(
      (
        await invite(c.Xp, c.org, {
          email: email(),
          roleId: c.org.roles.ADMIN.publicId,
        })
      ).body.code,
    ).toBe('owner_only');
    expect(
      (await invite(c.Xp, c.org, { email: email(), roleId: c.vPrime.publicId }))
        .body.code,
    ).toBe('owner_only');
    expect(
      (
        await invite(c.A, c.org, {
          email: email(),
          roleId: c.org.roles.ADMIN.publicId,
        })
      ).body.code,
    ).toBe('owner_only');
    // B-10: người giữ C1 không có `invitations.write` (C1 = MEMBER ∪ {members.role.assign}) → guard 403.
    const K = await seedP();
    await seedMemberInRole(c.org, c.c1, { authUserId: K.authUserId });
    expect(
      (
        await invite(K, c.org, {
          email: email(),
          roleId: c.org.roles.MEMBER.publicId,
        })
      ).body.code,
    ).toBe('forbidden');
    // Luật 2 thuần: role có quyền A không có (payroll.read) → 403 escalation_denied.
    const payroll = await seedCustomRole(c.org, {
      permissions: ['org.read', 'payroll.read'],
      name: `P ${v7()}`,
    });
    expect(
      (await invite(c.A, c.org, { email: email(), roleId: payroll.publicId }))
        .body.code,
    ).toBe('escalation_denied');
    expect(
      (await invite(c.A, c.org, { email: email(), roleId: v7() })).body.code,
    ).toBe('validation_failed');
  });

  /** Mời bằng `inviter`, đổi trạng thái của người mời/role bằng `mutate`, rồi chấp nhận: 409 + INVALIDATED + event có `reason`. */
  const invalidatedBy = async (
    c: Awaited<ReturnType<typeof cast>>,
    o: {
      inviterMemberId: string;
      role: SeededRole | { id: string; publicId: string };
      mutate: () => Promise<unknown>;
      reason: string;
    },
  ) => {
    const invitee = await seedP();
    const inv = await seedInvitation(c.org, {
      email: invitee.email,
      roleId: o.role.id,
      inviterMemberId: o.inviterMemberId,
    });
    await o.mutate();
    const r = await acceptInvitation(app, invitee, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([409, 'invitation_invalidated']);
    expect(await statusOf(c.org, inv.id)).toBe('INVALIDATED');
    expect(
      (await events(inv.publicId)).map((e) => [e.type, e.payload['reason']]),
    ).toEqual([['tenancy.invitation.invalidated', o.reason]]);
    expect(await membersOf(c.org, invitee)).toBe(0);
    expect(
      (await acceptInvitation(app, invitee, { token: inv.token })).body.code,
    ).toBe('invitation_not_found');
  };
  it('B-12: the inviter is demoted to MEMBER before the accept → INVITER_LACKS_GATE', async () => {
    const c = await cast();
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.c1,
      mutate: () =>
        sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [
          c.org.roles.MEMBER.id,
          c.aMemberId,
        ]),
      reason: 'INVITER_LACKS_GATE',
    });
  });
  it('B-20: the inviter loses invitations.write but still dominates C1 → INVITER_LACKS_GATE', async () => {
    const c = await cast();
    const noInvite = await seedCustomRole(c.org, {
      permissions: ADMIN_KEYS.filter((k) => k !== 'invitations.write'),
      name: `A- ${v7()}`,
    });
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.c1,
      mutate: () =>
        sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [
          noInvite.id,
          c.aMemberId,
        ]),
      reason: 'INVITER_LACKS_GATE',
    });
  });
  it('B-13: C1 gains a permission the inviter lacks before the accept → INVITER_NOT_DOMINANT', async () => {
    const c = await cast();
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.c1,
      mutate: () =>
        sql(
          c.org,
          `INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'payroll.read'`,
          [c.org.orgId, c.c1.id],
        ),
      reason: 'INVITER_NOT_DOMINANT',
    });
  });
  it('B-24 (invitation part): an owner invites with V′ ≡ ADMIN and is demoted to ADMIN before the accept → INVITER_NOT_DOMINANT (rule 2a)', async () => {
    const c = await cast();
    await seedMember(c.org, 'OWNER', {
      authUserId: (await seedP()).authUserId,
    }); // còn owner khác: hạ O không chạm owner cuối
    await invalidatedBy(c, {
      inviterMemberId: c.org.owner.memberId,
      role: c.vPrime,
      mutate: () =>
        sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [
          c.org.roles.ADMIN.id,
          c.org.owner.memberId,
        ]),
      reason: 'INVITER_NOT_DOMINANT',
    });
  });
  it('the inviter left the organization → INVITER_GONE', async () => {
    const c = await cast();
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.org.roles.MEMBER,
      mutate: () =>
        sql(c.org, 'DELETE FROM org_members WHERE id = $1', [c.aMemberId]),
      reason: 'INVITER_GONE',
    });
  });
  it('accept is a sensitive action: a stale session → 403 reauthentication_required, an unverified email → 403 email_not_verified; the invitation stays pending', async () => {
    const c = await cast();
    for (const [opts, code] of [
      [{ sessionAgeSec: 3600 }, 'reauthentication_required'],
      [{ emailVerified: false }, 'email_not_verified'],
    ] as const) {
      const p = await seedP(opts);
      const inv = await seedInvitation(c.org, {
        email: p.email,
        roleId: c.org.roles.MEMBER.id,
        inviterMemberId: c.aMemberId,
      });
      expect(
        (await acceptInvitation(app, p, { token: inv.token })).body.code,
      ).toBe(code);
      expect(await statusOf(c.org, inv.id)).toBe('PENDING');
    }
  });
});

describe('email invitations switched off (TENANCY_EMAIL_INVITATIONS=off, spec §13)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    app = await startTenancyApp({ env: { TENANCY_EMAIL_INVITATIONS: 'off' } });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('creating is 403 feature_disabled; an invitation that already exists still previews and accepts', async () => {
    const O = await seedUserPrincipal();
    const p = await seedUserPrincipal();
    principals.push(O, p);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const r = await authed(app, O)
      .post(`/v1/orgs/${org.orgId}/invitations`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ email: p.email, roleId: org.roles.MEMBER.publicId });
    expect([r.status, r.body.code]).toEqual([403, 'feature_disabled']);
    const inv = await seedInvitation(org, {
      email: p.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    expect(
      (await previewToken(app, 'invitations', { token: inv.token })).status,
    ).toBe(200);
    expect((await acceptInvitation(app, p, { token: inv.token })).status).toBe(
      201,
    );
  });
});
