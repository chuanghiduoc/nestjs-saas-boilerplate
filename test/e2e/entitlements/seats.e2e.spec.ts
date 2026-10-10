import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberSeatLimitAdapter } from '../../../src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.js';
import { MemberSeatLimit } from '../../../src/modules/tenancy/index.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  seedOrgEntitlement,
  seedOverride,
  setOrgPlan,
} from '../../support/entitlements-seed.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import {
  acceptInvitation,
  joinInviteLink,
} from '../../support/tenancy-acquisition.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
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
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RUNS = 50;
const JOINERS = 4;
/** Gói mặc định một ghế cho cả file (Review Focus 4): org tạo qua API rơi vào `solo`; ca khác seed gói tường minh. */
const soloFirst = { ...fixturePlans, defaultPlan: 'solo' };
const SEAT_ERROR = {
  path: 'feature',
  code: 'tenancy.seats',
  message: 'Quota exceeded',
};

describe('seats through the entitlements adapter (spec SP4 §9.6, E-6; SE-1, SE-2, SE-3)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let owner: SeededPrincipal;
  const joiners: SeededPrincipal[] = [];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const created: string[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const sql = (orgId: string, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, orgId, () => c.query(q, params)));
  const memberCount = async (orgId: string) =>
    Number(
      (await sql(orgId, 'SELECT count(*)::int AS n FROM org_members')).rows[0]
        ?.n,
    );
  const orgOn = async (plan: string) => {
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    await seedOrgEntitlement(org.orgId, plan);
    return org;
  };
  const linkOf = (org: SeededOrg, maxUses = 10) =>
    seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses,
    });
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(soloFirst, {
      extraImports: [FixtureFeaturesModule],
      env: { THROTTLE_DEFAULT_LIMIT: '100000' },
    });
    owner = await seedP();
    for (let i = 0; i < JOINERS; i++) joiners.push(await seedP());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    await disposeCatalogue?.();
  });

  it('the api composition resolves MemberSeatLimit to the entitlements adapter', () => {
    expect(app.get(MemberSeatLimit)).toBeInstanceOf(MemberSeatLimitAdapter);
  });
  it(`SE-1 (E-6): ${JOINERS} parallel joins with 2 free seats → exactly 2 members, 2 × 422 quota_exceeded, use_count 2, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const org = await orgOn('metered');
      const link = await linkOf(org);
      const rs = await raceOnOrgLock(org.orgId, JOINERS, () =>
        Promise.all(
          joiners.map((p) => joinInviteLink(app, p, { token: link.token })),
        ),
      );
      expect(rs.map((r) => r.status).sort(), `run ${i}`).toEqual([
        201, 201, 422, 422,
      ]);
      for (const r of rs.filter((x) => x.status === 422))
        expect([r.body.code, r.body.errors?.[0]], `run ${i}`).toEqual([
          'quota_exceeded',
          SEAT_ERROR,
        ]);
      expect(await memberCount(org.orgId), `run ${i}`).toBe(3);
      expect(
        (
          await sql(
            org.orgId,
            'SELECT use_count FROM org_invite_links WHERE id = $1',
            [link.id],
          )
        ).rows,
        `run ${i}`,
      ).toEqual([{ use_count: 2 }]);
    }
  }, 600_000);
  it('SE-2: a downgrade below the member count removes nobody; accepting is refused; after removing 4 members it succeeds', async () => {
    const org = await orgOn('pro');
    const extra: string[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await seedMember(org, 'MEMBER', {
        authUserId: (await seedP()).authUserId,
      });
      extra.push(m.memberPublicId);
    }
    await setOrgPlan(org.orgId, 'duo');
    expect(await memberCount(org.orgId)).toBe(5);
    const invitee = await seedP();
    const inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    const refused = await acceptInvitation(app, invitee, { token: inv.token });
    expect([refused.status, refused.body.errors?.[0]]).toEqual([
      422,
      SEAT_ERROR,
    ]);
    expect(await memberCount(org.orgId)).toBe(5);
    for (const id of extra)
      expect(
        (await authed(app, owner).delete(`/v1/orgs/${org.orgId}/members/${id}`))
          .status,
      ).toBe(204);
    expect(
      (await acceptInvitation(app, invitee, { token: inv.token })).status,
    ).toBe(201);
    expect(await memberCount(org.orgId)).toBe(2);
  });
  it('Review Focus 4: a one-seat plan admits the creator and nobody else', async () => {
    const creator = await seedP();
    const r = await authed(app, creator)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'One seat' });
    expect(r.status).toBe(201);
    const orgId: string = r.body.id;
    created.push(orgId);
    expect(
      (await authed(app, creator).get(`/v1/orgs/${orgId}/entitlements`)).body
        .features,
    ).toContainEqual(
      expect.objectContaining({
        key: 'tenancy.seats',
        limit: 1,
        unlimited: false,
      }),
    );
    const role = (
      await sql(
        orgId,
        `SELECT public_id::text AS id FROM org_roles WHERE system_key = 'MEMBER'`,
      )
    ).rows[0]?.id;
    const link = await authed(app, creator)
      .post(`/v1/orgs/${orgId}/invite-links`)
      .send({
        roleId: role,
        maxUses: 5,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(link.status).toBe(201);
    const token = new URL(link.body.url).hash.replace('#token=', '');
    const join = await joinInviteLink(app, await seedP(), { token });
    expect([join.status, join.body.errors?.[0]]).toEqual([422, SEAT_ERROR]);
    expect(await memberCount(orgId)).toBe(1);
  });
  it('I1 through the adapter: an existing member joining or accepting into a full org still gets 409 already_member', async () => {
    const org = await orgOn('solo');
    const link = await linkOf(org);
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
    expect(await memberCount(org.orgId)).toBe(2);
  });
  it('an org without its entitlement row: a join answers 503 + Retry-After and nothing is written (fail closed, never unlimited)', async () => {
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const link = await linkOf(org);
    const r = await joinInviteLink(app, joiners[0]!, { token: link.token });
    expect([r.status, r.body.code, r.headers['retry-after']]).toEqual([
      503,
      'service_unavailable',
      '5',
    ]);
    expect(await memberCount(org.orgId)).toBe(1);
    expect(
      (
        await sql(
          org.orgId,
          'SELECT use_count FROM org_invite_links WHERE id = $1',
          [link.id],
        )
      ).rows,
    ).toEqual([{ use_count: 0 }]);
  });
  it('4C: a seat override below the plan blocks the next join through the real MemberAdmission; an expired one does not', async () => {
    const capped = await orgOn('metered');
    await seedOverride(capped.orgId, 'tenancy.seats', {
      value: { limit: 1 },
      expiresInSec: 3600,
    });
    const [joiner] = joiners;
    if (!joiner) throw new Error('no joiner seeded');
    const refused = await joinInviteLink(app, joiner, {
      token: (await linkOf(capped)).token,
    });
    expect([
      refused.status,
      refused.body.code,
      refused.body.errors?.[0],
    ]).toEqual([422, 'quota_exceeded', SEAT_ERROR]);
    expect(await memberCount(capped.orgId)).toBe(1);
    const lapsed = await orgOn('metered');
    await seedOverride(lapsed.orgId, 'tenancy.seats', {
      value: { limit: 1 },
      expiresInSec: -1,
    });
    const ok = await joinInviteLink(app, joiner, {
      token: (await linkOf(lapsed)).token,
    });
    expect(ok.status).toBe(201);
    expect(await memberCount(lapsed.orgId)).toBe(2);
  });
});
