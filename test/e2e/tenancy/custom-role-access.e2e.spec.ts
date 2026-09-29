import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import {
  ROLE_SET_C0,
  inOrgTx,
  roleSetC1,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('custom roles on the hot path and in the in-transaction re-check (spec SP3 §7.3, §8.6)', () => {
  let app: INestApplication;
  /** C1 = MEMBER ∪ {members.role.assign} của catalogue gộp thật của app (R-X24): B-21 cần C1 trội MEMBER. */
  let C1: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const c1 = await seedCustomRole(org, { permissions: C1, name: 'C1' });
    const c0 = await seedCustomRole(org, {
      permissions: ROLE_SET_C0,
      name: 'C0',
    });
    const c1p = await seedP();
    const c0p = await seedP();
    const mp = await seedP();
    await seedMemberInRole(org, c1, { authUserId: c1p.authUserId });
    await seedMemberInRole(org, c0, { authUserId: c0p.authUserId });
    const m = await seedMember(org, 'MEMBER', { authUserId: mp.authUserId });
    return { org, c1, c0, c1p, c0p, m };
  };
  beforeAll(async () => {
    app = await startTenancyApp();
    C1 = roleSetC1(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a C1 holder passes the guard for its keys; a C0 holder is a member without members.read', async () => {
    const c = await cast();
    expect(
      (await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/members`)).status,
    ).toBe(200);
    expect(
      (await authed(app, c.c0p).get(`/v1/orgs/${c.org.orgId}/members/me`))
        .status,
    ).toBe(200);
    const denied = await authed(app, c.c0p).get(
      `/v1/orgs/${c.org.orgId}/members`,
    );
    expect([denied.status, denied.body.code]).toEqual([403, 'forbidden']);
  });
  it('GET roles lists system and custom roles; a custom role carries its stored keys, sorted', async () => {
    const c = await cast();
    const r = await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/roles`);
    expect(r.status).toBe(200);
    expect(
      r.body.data.find((x: { id: string }) => x.id === c.c1.publicId),
    ).toMatchObject({ systemKey: null, name: 'C1', permissions: C1 });
    expect(
      (
        await authed(app, c.c1p).get(
          `/v1/orgs/${c.org.orgId}/roles/${c.c0.publicId}`,
        )
      ).body.permissions,
    ).toEqual(['org.read']);
  });
  it('the in-transaction re-check reads the custom set: C1 moves a MEMBER to C0 (B-21 through the API)', async () => {
    const c = await cast();
    const r = await authed(app, c.c1p)
      .patch(`/v1/orgs/${c.org.orgId}/members/${c.m.memberPublicId}`)
      .set('if-match', '*')
      .send({ roleId: c.c0.publicId });
    expect(r.status).toBe(200);
    expect(r.body.role).toEqual({
      id: c.c0.publicId,
      systemKey: null,
      name: 'C0',
    });
  });
  it('R-14 (SQL): removing members.read (and its dependant) from C1 takes effect on the next request (no cache, PR18)', async () => {
    const c = await cast();
    expect(
      (await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/members`)).status,
    ).toBe(200);
    await withAppClient((db) =>
      inOrgTx(db, c.org.orgId, () =>
        db.query(
          `DELETE FROM org_role_permissions rp USING permissions p WHERE p.id = rp.permission_id AND rp.role_id = $1 AND p.key IN ('members.read', 'members.role.assign')`,
          [c.c1.id],
        ),
      ),
    );
    expect(
      (await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/members`)).status,
    ).toBe(403);
  });
});
