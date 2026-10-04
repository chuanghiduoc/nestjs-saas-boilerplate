import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { joinInviteLink } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const HEADER = 'x-api-key';

describe('delegations through the membership and organization lifecycle (spec SP3 §9.4, §9.6, §9.7, §14.1; §18.3 K-6, S-15; tiêu chí 8)', () => {
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const keyGet = (token: string, url: string) =>
    request(app.getHttpServer()).get(url).set(HEADER, token);
  const revokedEvents = (aggregateId: string) =>
    ownerQuery<{ payload: { reason: string } }>(
      `SELECT payload FROM outbox_events WHERE type IN ('tenancy.api_key.revoked', 'tenancy.support_access.revoked') AND aggregate_id = $1 ORDER BY id`,
      [aggregateId],
    );
  /** org_api_keys/org_support_grants là FORCE RLS: đọc bằng app_user trong OrgScope (ownerQuery không thấy dòng nào). */
  const inOrgRows = <R extends Record<string, unknown>>(
    org: SeededOrg,
    sql: string,
    params: unknown[],
  ) =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, async () => (await c.query<R>(sql, params)).rows),
    );
  const cast = async () => {
    const O = await seedUserPrincipal();
    const A = await seedUserPrincipal();
    principals.push(O, A);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const key = await seedOrgApiKey(org, {
      createdByMemberId: a.memberId,
      permissions: ['org.read'],
    });
    return { O, A, a, org, key };
  };

  beforeAll(async () => {
    app = await startTenancyApp();
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('K-6: removing the creator → 401, the key row is gone, event api_key.revoked CREATOR_REMOVED; leaving does the same', async () => {
    const c = await cast();
    expect((await keyGet(c.key.token, `/v1/orgs/${c.org.orgId}`)).status).toBe(
      200,
    );
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/members/${c.a.memberPublicId}`,
        )
      ).status,
    ).toBe(204);
    expect((await keyGet(c.key.token, `/v1/orgs/${c.org.orgId}`)).status).toBe(
      401,
    );
    expect(
      await inOrgRows(
        c.org,
        `SELECT 1 FROM org_api_keys WHERE public_id = $1`,
        [c.key.publicId],
      ),
    ).toEqual([]);
    expect(
      (await revokedEvents(c.key.publicId)).map((e) => e.payload.reason),
    ).toEqual(['CREATOR_REMOVED']);
    const d = await cast();
    expect(
      (await authed(app, d.A).delete(`/v1/orgs/${d.org.orgId}/members/me`))
        .status,
    ).toBe(204);
    expect(
      (await revokedEvents(d.key.publicId)).map((e) => e.payload.reason),
    ).toEqual(['CREATOR_REMOVED']);
  });
  it('K-6 (account deletion): a stepped-up staff removes the creator account (/admin/remove-user) → event CREATOR_REMOVED', async () => {
    const c = await cast();
    const admin = await seedStaffPrincipal();
    principals.push(admin);
    const del = await authed(app, admin)
      .post('/api/auth/admin/remove-user')
      .set('origin', 'http://localhost:3000')
      .send({ userId: c.A.authUserId });
    expect(del.status).toBe(200);
    expect(
      (await revokedEvents(c.key.publicId)).map((e) => e.payload.reason),
    ).toEqual(['CREATOR_REMOVED']);
  });
  it('tiêu chí 8 / T-31: soft delete → keys 401 and grants 404 at once; both stay revoked after restore', async () => {
    const c = await cast();
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const g = await seedSupportGrant(c.org, {
      grantee: { authUserId: staff.authUserId },
      grantedByMemberId: c.org.owner.memberId,
      permissions: preset,
    });
    expect(
      (await authed(app, staff).get(`/v1/orgs/${c.org.orgId}`)).status,
    ).toBe(200);
    expect(
      (await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}`)).status,
    ).toBe(204);
    expect((await keyGet(c.key.token, `/v1/orgs/${c.org.orgId}`)).status).toBe(
      401,
    );
    expect(
      (await authed(app, staff).get(`/v1/orgs/${c.org.orgId}`)).status,
    ).toBe(404);
    expect(
      (
        await authed(app, c.O)
          .post(`/v1/orgs/${c.org.orgId}/restore`)
          .set('idempotency-key', `k-${c.org.orgId}`)
      ).status,
    ).toBe(200);
    expect((await keyGet(c.key.token, `/v1/orgs/${c.org.orgId}`)).status).toBe(
      401,
    );
    expect(
      (await authed(app, staff).get(`/v1/orgs/${c.org.orgId}`)).status,
    ).toBe(404);
    expect(
      await inOrgRows<{ k: boolean; g: boolean }>(
        c.org,
        `SELECT (SELECT revoked_at IS NOT NULL FROM org_api_keys WHERE public_id = $1) AS k,
                (SELECT revoked_at IS NOT NULL FROM org_support_grants WHERE public_id = $2) AS g`,
        [c.key.publicId, g.publicId],
      ),
    ).toEqual([{ k: true, g: true }]);
  });
  it('Review Focus 3 / S-15: a grantee who becomes a member is served as a member', async () => {
    const c = await cast();
    const staff = await seedStaffPrincipal({ mark: false });
    principals.push(staff);
    const g = await seedSupportGrant(c.org, {
      grantee: { authUserId: staff.authUserId },
      grantedByMemberId: c.org.owner.memberId,
      permissions: preset,
    });
    const link = await seedInviteLink(c.org, {
      roleId: c.org.roles.MEMBER.id,
      createdByMemberId: c.org.owner.memberId,
    });
    expect(
      (await joinInviteLink(app, staff, { token: link.token })).status,
    ).toBe(201);
    expect(
      (await revokedEvents(g.publicId)).map((e) => e.payload.reason),
    ).toEqual(['GRANTEE_BECAME_MEMBER']);
    const r = await authed(app, staff).get(
      `/v1/orgs/${c.org.orgId}/members/me`,
    ); // @OrgMemberOnly: chỉ MEMBERSHIP qua được
    expect(r.status).toBe(200);
    expect(
      await inOrgRows(
        c.org,
        `SELECT 1 FROM org_support_grants WHERE public_id = $1 AND revoked_at IS NULL`,
        [g.publicId],
      ),
    ).toEqual([]);
  });
});
