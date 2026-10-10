import { Global, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import {
  MemberSeatLimit,
  type SeatLimit,
} from '../../../src/modules/tenancy/index.js';
import { ownerQuery } from '../../support/identity-app.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import {
  acceptInvitation,
  joinInviteLink,
} from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  deleteTenancyUsersOf,
  inOrgTx,
  purgeOrgs,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
/** Trần do test đặt; `throw` mô phỏng adapter đọc lỗi (DB) → phải fail closed, không bao giờ "không giới hạn". */
const port: { limit: SeatLimit; fail: AppError | undefined } = {
  limit: { kind: 'UNLIMITED' },
  fail: undefined,
};
class StubSeatLimit extends MemberSeatLimit {
  current(): Promise<SeatLimit> {
    return port.fail ? Promise.reject(port.fail) : Promise.resolve(port.limit);
  }
}
/** Cùng hình dạng module của entitlements (`@Global`, export đúng token): tenancy không biết ai cài port. */
@Global()
@Module({
  providers: [{ provide: MemberSeatLimit, useClass: StubSeatLimit }],
  exports: [MemberSeatLimit],
})
class StubSeatLimitModule {}

const sql = (org: SeededOrg, q: string, params: unknown[] = []) =>
  withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
const memberCount = async (org: SeededOrg) =>
  Number(
    (await sql(org, 'SELECT count(*)::int AS n FROM org_members')).rows[0]?.n,
  );
/** `outbox_events` không FORCE RLS: đọc bằng owner được (bảng hạ tầng). Event chỉ phát SAU kiểm ghế. */
const memberAddedEvents = async (org: SeededOrg) =>
  (
    await ownerQuery(
      `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.added'`,
      [org.orgId],
    )
  ).length;
const useCount = async (org: SeededOrg, linkId: string) =>
  Number(
    (
      await sql(org, 'SELECT use_count FROM org_invite_links WHERE id = $1', [
        linkId,
      ])
    ).rows[0]?.use_count,
  );

describe('MemberSeatLimit in MemberAdmission (spec SP4 §9.6, §22.2 T5)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const created: string[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgWithLink = async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 10,
    });
    return { org, owner, link };
  };
  beforeAll(async () => {
    app = await startTenancyApp({
      extraImports: [StubSeatLimitModule],
      env: { THROTTLE_DEFAULT_LIMIT: '100000' },
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
  });

  it('MAX(2) with one member: a join fits, the next one is 422 quota_exceeded with errors[0].code = featureKey; nothing is written', async () => {
    port.limit = { kind: 'MAX', max: 2, featureKey: 'tenancy.seats' };
    const { org, link } = await orgWithLink();
    expect(
      (await joinInviteLink(app, await seedP(), { token: link.token })).status,
    ).toBe(201);
    const full = await joinInviteLink(app, await seedP(), {
      token: link.token,
    });
    expect([full.status, full.body.code, full.body.errors?.[0]]).toEqual([
      422,
      'quota_exceeded',
      { path: 'feature', code: 'tenancy.seats', message: 'Quota exceeded' },
    ]);
    expect([await memberCount(org), await useCount(org, link.id)]).toEqual([
      2, 1,
    ]);
    // Chỉ lần join đầu phát `tenancy.member.added`; lần bị từ chối rollback trước khi publish (outbox không có dòng thứ hai).
    expect(await memberAddedEvents(org)).toBe(1);
    expect(
      await otel.metric('tenancy_seat_limit_denied_total', {
        source: 'INVITE_LINK',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await otel.metric('tenancy_invite_link_joins_total', {
        result: 'seat_limit',
      }),
    ).toBeGreaterThanOrEqual(1);
  });
  it('I1: an existing member joining or accepting into a full org still gets 409 already_member (the unique violation fires before the seat check)', async () => {
    port.limit = { kind: 'MAX', max: 2, featureKey: 'tenancy.seats' };
    const { org, link } = await orgWithLink();
    const member = await seedP();
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    const join = await joinInviteLink(app, member, { token: link.token });
    expect([join.status, join.body.code]).toEqual([409, 'already_member']);
    const inv = await seedInvitation(org, {
      email: member.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    const accepted = await acceptInvitation(app, member, { token: inv.token });
    expect([accepted.status, accepted.body.code]).toEqual([
      409,
      'already_member',
    ]);
    expect([await memberCount(org), await useCount(org, link.id)]).toEqual([
      2, 0,
    ]);
  });
  it('an invitation accepted at the limit is 422 and the invitation stays PENDING (a pending invitation takes no seat)', async () => {
    port.limit = { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' };
    const { org } = await orgWithLink();
    const invitee = await seedP();
    const inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    const r = await acceptInvitation(app, invitee, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([422, 'quota_exceeded']);
    expect(
      (
        await sql(org, 'SELECT status FROM org_invitations WHERE id = $1', [
          inv.id,
        ])
      ).rows,
    ).toEqual([{ status: 'PENDING' }]);
    expect(
      await otel.metric('tenancy_invitations_total', { result: 'seat_limit' }),
    ).toBeGreaterThanOrEqual(1);
  });
  it('creating an org: MAX(1) admits the creator; MAX(0) refuses it and no organization is left behind', async () => {
    const creator = await seedP();
    port.limit = { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' };
    const ok = await authed(app, creator)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'Seat 1' });
    expect(ok.status).toBe(201);
    created.push(ok.body.id);
    port.limit = { kind: 'MAX', max: 0, featureKey: 'tenancy.seats' };
    const refused = await authed(app, creator)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'Seat 0' });
    expect([refused.status, refused.body.code]).toEqual([
      422,
      'quota_exceeded',
    ]);
    const list = await authed(app, creator).get('/v1/orgs');
    expect((list.body.data as { id: string }[]).map((o) => o.id)).toEqual([
      ok.body.id,
    ]);
  });
  it('a support grantee refused for a full org keeps the grant: the 3D revocation rolls back with the membership, no event', async () => {
    port.limit = { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' };
    const { org, link } = await orgWithLink();
    const staff = await seedStaffPrincipal({ mark: false });
    principals.push(staff);
    const g = await seedSupportGrant(org, {
      grantee: { authUserId: staff.authUserId },
      grantedByMemberId: org.owner.memberId,
      permissions: supportPresetKeys(
        app.get(PermissionCatalogueRegistry).merged(),
      ),
    });
    const r = await joinInviteLink(app, staff, { token: link.token });
    expect([r.status, r.body.code]).toEqual([422, 'quota_exceeded']);
    expect(
      (
        await sql(
          org,
          'SELECT revoked_at IS NULL AS active FROM org_support_grants WHERE public_id = $1',
          [g.publicId],
        )
      ).rows,
    ).toEqual([{ active: true }]);
    expect(
      (
        await ownerQuery(
          `SELECT 1 FROM outbox_events WHERE type = 'tenancy.support_access.revoked' AND aggregate_id = $1`,
          [g.publicId],
        )
      ).length,
    ).toBe(0);
    expect([
      await memberCount(org),
      await useCount(org, link.id),
      await memberAddedEvents(org),
    ]).toEqual([1, 0, 0]);
  });
  it('the port failing (an infrastructure error of the adapter) fails closed: 503, the link use and the membership roll back', async () => {
    port.limit = { kind: 'UNLIMITED' };
    port.fail = new AppError(CoreErrors.SERVICE_UNAVAILABLE);
    try {
      const { org, link } = await orgWithLink();
      const r = await joinInviteLink(app, await seedP(), { token: link.token });
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect([await memberCount(org), await useCount(org, link.id)]).toEqual([
        1, 0,
      ]);
    } finally {
      port.fail = undefined;
    }
  });
});

describe('SE-3: without a MemberSeatLimit provider (entitlements not installed) seats are unlimited, as in SP3', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  let org: SeededOrg;
  beforeAll(async () => {
    app = await startTenancyApp({ env: { THROTTLE_DEFAULT_LIMIT: '100000' } });
  });
  afterAll(async () => {
    await org?.dispose();
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
  });
  it('five joins through one link all succeed', async () => {
    const owner = await seedUserPrincipal();
    principals.push(owner);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 5,
    });
    for (let i = 0; i < 5; i++) {
      const p = await seedUserPrincipal();
      principals.push(p);
      expect((await joinInviteLink(app, p, { token: link.token })).status).toBe(
        201,
      );
    }
    expect(await memberCount(org)).toBe(6);
  });
});

describe('MemberSeatLimit in single-membership mode (spec SP3 §13 + SP4 §9.6)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  beforeAll(async () => {
    app = await startTenancyApp({
      extraImports: [StubSeatLimitModule],
      env: {
        TENANCY_MEMBERSHIP_MODE: 'single',
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
    });
  });
  afterAll(async () => {
    port.limit = { kind: 'UNLIMITED' };
    for (const o of orgs) await o.dispose();
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });
  it('a full org refuses a free user with 422 quota_exceeded; a user already in another org still gets 409 already_in_an_org first', async () => {
    port.limit = { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' };
    const owners = [await seedP(), await seedP()];
    const full = await seedOrg({
      owner: { authUserId: owners[0]!.authUserId },
    });
    const other = await seedOrg({
      owner: { authUserId: owners[1]!.authUserId },
    });
    orgs.push(full, other);
    const link = await seedInviteLink(full, {
      roleId: full.roles.MEMBER.id,
      createdByMemberId: full.owner.memberId,
      maxUses: 10,
    });
    const free = await joinInviteLink(app, await seedP(), {
      token: link.token,
    });
    expect([free.status, free.body.code]).toEqual([422, 'quota_exceeded']);
    const elsewhere = await seedP();
    await seedMember(other, 'MEMBER', { authUserId: elsewhere.authUserId });
    const taken = await joinInviteLink(app, elsewhere, { token: link.token });
    expect([taken.status, taken.body.code]).toEqual([409, 'already_in_an_org']);
    expect([
      await memberCount(full),
      await useCount(full, link.id),
      await memberAddedEvents(full),
    ]).toEqual([1, 0, 0]);
  });
  it('MAX(0) refuses every join (no seat at all), nothing written', async () => {
    port.limit = { kind: 'MAX', max: 0, featureKey: 'tenancy.seats' };
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 10,
    });
    const r = await joinInviteLink(app, await seedP(), { token: link.token });
    expect([r.status, r.body.code]).toEqual([422, 'quota_exceeded']);
    expect([
      await memberCount(org),
      await useCount(org, link.id),
      await memberAddedEvents(org),
    ]).toEqual([1, 0, 0]);
  });
});
