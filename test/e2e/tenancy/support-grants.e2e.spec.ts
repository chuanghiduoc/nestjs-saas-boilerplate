import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgRouteInventory } from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const MAX_TTL = 7_200;

describe('support grants: grant, list, revoke (spec SP3 §9.7, §12; §18.3 S-1–S-3, S-8, S-13, S-14; T-20; Review Focus 2)', () => {
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const track = <T extends SeededPrincipal>(p: T) => (principals.push(p), p);
  const cast = async () => {
    const O = track(await seedUserPrincipal());
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = track(await seedUserPrincipal());
    await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const staff = track(await seedStaffPrincipal());
    return { org, O, A, staff };
  };
  const grant = (
    p: SeededPrincipal,
    org: SeededOrg,
    body: Record<string, unknown>,
  ) =>
    authed(app, p)
      .post(`/v1/orgs/${org.orgId}/support-grants`)
      .set('idempotency-key', `k-${v7()}`)
      .send(body);
  const body = (
    staff: SeededPrincipal,
    extra: Record<string, unknown> = {},
  ) => ({
    staffUserId: staff.authUserId,
    expiresInSec: 900,
    reason: 'SUP-1234',
    ...extra,
  });
  const tenancyUsersOf = async (authUserId: string) =>
    (
      await ownerQuery(`SELECT 1 FROM tenancy_users WHERE auth_user_id = $1`, [
        authUserId,
      ])
    ).length;
  /** org_support_grants là FORCE RLS: đọc bằng app_user trong OrgScope (ownerQuery không có context thì không thấy gì). */
  const grantRows = (org: SeededOrg) =>
    withAppClient((c) =>
      inOrgTx(
        c,
        org.orgId,
        async () =>
          (
            await c.query<{ public_id: string; revoked: boolean }>(
              `SELECT public_id::text, revoked_at IS NOT NULL AS revoked FROM org_support_grants ORDER BY id`,
            )
          ).rows,
      ),
    );

  beforeAll(async () => {
    app = await startTenancyApp({
      env: { TENANCY_SUPPORT_GRANT_MAX_TTL_SEC: String(MAX_TTL) },
    });
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('201: the owner grants the read-only preset (S-14: never billing.read); event granted; GET lists it', async () => {
    const c = await cast();
    const r = await grant(c.O, c.org, body(c.staff));
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(
      `/v1/orgs/${c.org.orgId}/support-grants/${r.body.id}`,
    );
    expect(r.body).toMatchObject({
      permissions: preset,
      reason: 'SUP-1234',
      revokedAt: null,
      firstUsedAt: null,
    });
    expect(r.body.permissions).not.toContain('billing.read');
    const evs = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.support_access.granted' AND aggregate_id = $1`,
      [r.body.id],
    );
    expect(evs.map((e) => e.payload)).toEqual([
      {
        grantId: r.body.id,
        granteeUserId: r.body.granteeUserId,
        grantedByMemberId: c.org.owner.memberPublicId,
        permissions: preset,
        expiresAt: r.body.expiresAt,
      },
    ]);
    expect(JSON.stringify(evs)).not.toContain('SUP-1234'); // reason không vào event
    const list = await authed(app, c.O).get(
      `/v1/orgs/${c.org.orgId}/support-grants`,
    );
    expect(list.body.data.map((g: { id: string }) => g.id)).toEqual([
      r.body.id,
    ]);
  });
  it('S-1: an ADMIN grants → 403; S-2: there is no route for staff to grant themselves anything', async () => {
    const c = await cast();
    expect((await grant(c.A, c.org, body(c.staff))).status).toBe(403);
    const ids = app
      .get(OrgRouteInventory)
      .tenantRoutes()
      .map((r) => r.id)
      .filter((id) => id.includes('support-grants'));
    expect(ids.sort()).toEqual(
      [
        'DELETE v1/orgs/:orgId/support-grants/:grantId',
        'GET v1/orgs/:orgId/support-grants',
        'POST v1/orgs/:orgId/support-grants',
      ].sort(),
    );
  });
  it('S-3/S-13: a member, a user without 2FA, a non-staff user, a banned staff, a random id → one 422 support_grantee_ineligible, no tenancy_users row', async () => {
    const c = await cast();
    const noFactor = track(await seedUserPrincipal({ role: 'admin' }));
    const plain = track(await seedUserPrincipal());
    const banned = track(await seedStaffPrincipal());
    await ownerQuery(`UPDATE auth."user" SET banned = true WHERE id = $1`, [
      banned.authUserId,
    ]);
    const member = track(await seedStaffPrincipal());
    await seedMember(c.org, 'MEMBER', { authUserId: member.authUserId });
    for (const who of [noFactor, plain, banned]) {
      const r = await grant(c.O, c.org, body(who));
      expect([
        r.status,
        r.body.code,
        await tenancyUsersOf(who.authUserId),
      ]).toEqual([422, 'support_grantee_ineligible', 0]);
    }
    const asMember = await grant(c.O, c.org, body(member));
    expect([asMember.status, asMember.body.code]).toEqual([
      422,
      'support_grantee_ineligible',
    ]);
    const random = await grant(c.O, c.org, {
      ...body(c.staff),
      staffUserId: v7(),
    });
    expect([random.status, random.body.code]).toEqual([
      422,
      'support_grantee_ineligible',
    ]);
    expect(await grantRows(c.org)).toEqual([]);
  });
  it('T-20: granting again revokes the open grant of the same staff (one open grant per grantee) with event REVOKED', async () => {
    const c = await cast();
    const first = await grant(c.O, c.org, body(c.staff));
    const second = await grant(c.O, c.org, body(c.staff));
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await grantRows(c.org)).toEqual([
      { public_id: first.body.id, revoked: true },
      { public_id: second.body.id, revoked: false },
    ]);
    const evs = await ownerQuery<{ payload: { reason: string } }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.support_access.revoked' AND aggregate_id = $1`,
      [first.body.id],
    );
    expect(evs.map((e) => e.payload.reason)).toEqual(['REVOKED']);
    const rs = await Promise.all([
      grant(c.O, c.org, body(c.staff)),
      grant(c.O, c.org, body(c.staff)),
    ]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect((await grantRows(c.org)).filter((g) => !g.revoked)).toHaveLength(1);
  });
  it('Review Focus 2 (grant): expiresInSec at the max → 201, max + 1 → 422 ttl_out_of_range; bad numbers and reasons → 422 validation_failed', async () => {
    const c = await cast();
    expect(
      (await grant(c.O, c.org, body(c.staff, { expiresInSec: MAX_TTL })))
        .status,
    ).toBe(201);
    const over = await grant(
      c.O,
      c.org,
      body(c.staff, { expiresInSec: MAX_TTL + 1 }),
    );
    expect([over.status, over.body.code]).toEqual([422, 'ttl_out_of_range']);
    for (const bad of [0, -5, 2.5, '900'])
      expect(
        (await grant(c.O, c.org, body(c.staff, { expiresInSec: bad }))).body
          .code,
        String(bad),
      ).toBe('validation_failed');
    for (const reason of ['', '  ', 'x'.repeat(501)])
      expect(
        (await grant(c.O, c.org, body(c.staff, { reason }))).body.code,
        JSON.stringify(reason),
      ).toBe('validation_failed');
    expect(
      (await grant(c.O, c.org, body(c.staff, { staffUserId: 'NOT-A-UUID' })))
        .body.code,
    ).toBe('validation_failed');
  });
  it('S-8: the staff cannot extend or re-grant through the org (403/404), even with a step-up; the owner revokes → 204, event REVOKED, idempotent', async () => {
    const c = await cast();
    const g = await grant(c.O, c.org, body(c.staff));
    expect(g.status).toBe(201);
    const self = await grant(
      c.staff,
      c.org,
      body(c.staff, { expiresInSec: MAX_TTL }),
    );
    expect([403, 404]).toContain(self.status);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await authed(app, c.O).delete(
            `/v1/orgs/${c.org.orgId}/support-grants/${g.body.id}`,
          )
        ).status,
      ).toBe(204);
    const evs = await ownerQuery<{ payload: { reason: string } }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.support_access.revoked' AND aggregate_id = $1`,
      [g.body.id],
    );
    expect(evs.map((e) => e.payload.reason)).toEqual(['REVOKED']);
  });
});

describe('support grants switched off (U17: TENANCY_SUPPORT_GRANTS=off)', () => {
  it('POST → 403 feature_disabled; GET and DELETE still work for grants that exist (closing is always possible)', async () => {
    const app = await startTenancyApp({
      env: { TENANCY_SUPPORT_GRANTS: 'off' },
    });
    const O = await seedUserPrincipal();
    const staff = await seedStaffPrincipal();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    try {
      const existing = await seedSupportGrant(org, {
        grantee: { externalSubject: `test:${v7()}` },
        grantedByMemberId: org.owner.memberId,
        permissions: supportPresetKeys(
          app.get(PermissionCatalogueRegistry).merged(),
        ),
      });
      const r = await authed(app, O)
        .post(`/v1/orgs/${org.orgId}/support-grants`)
        .set('idempotency-key', `k-${v7()}`)
        .send({
          staffUserId: staff.authUserId,
          expiresInSec: 900,
          reason: 'x',
        });
      expect([r.status, r.body.code]).toEqual([403, 'feature_disabled']);
      const list = await authed(app, O).get(
        `/v1/orgs/${org.orgId}/support-grants`,
      );
      expect([list.status, list.body.data.length]).toEqual([200, 1]);
      expect(
        (
          await authed(app, O).delete(
            `/v1/orgs/${org.orgId}/support-grants/${existing.publicId}`,
          )
        ).status,
      ).toBe(204);
    } finally {
      await org.dispose();
      await app.close();
      await deleteSeededPrincipals([O, staff]);
    }
  });
});
