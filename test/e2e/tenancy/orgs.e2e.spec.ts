import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CatalogueCheck } from '../../../src/modules/tenancy/application/catalogue-check.js';
import { OrgRouteInventory } from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  deleteTenancyUsersOf,
  purgeOrgs,
  seedMember,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const MAX_ORGS = 3;
const RACE_ROUNDS = 10;
const BOOT_CHECK_BUDGET_MS = 200;
const idem = () => `k-${v7()}`;

describe('organizations API (spec SP3 §9.4, §12)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const seeded: SeededOrg[] = [];
  const createdOrgIds: string[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const create = (p: SeededPrincipal, body: object) =>
    authed(app, p).post('/v1/orgs').set('idempotency-key', idem()).send(body);
  beforeAll(async () => {
    app = await startTenancyApp({
      env: { TENANCY_MAX_ORGS_CREATED_PER_USER: String(MAX_ORGS) },
    });
  });
  afterAll(async () => {
    for (const o of seeded) await o.dispose();
    await purgeOrgs(createdOrgIds);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('POST /v1/orgs → 201 + Location + ETag; creator is OWNER; member.added and org.created share the transaction', async () => {
    const p = await seedP();
    const r = await create(p, {
      name: 'Acme',
      id: '00000000-0000-7000-8000-000000000000',
    });
    expect(r.status).toBe(201);
    createdOrgIds.push(r.body.id);
    expect(r.body.id).not.toBe('00000000-0000-7000-8000-000000000000'); // Review Focus 5: id của client bị bỏ qua
    expect(r.headers['location']).toBe(`/v1/orgs/${r.body.id}`);
    expect(r.headers['etag']).toBe('W/"1"');
    const list = await authed(app, p).get('/v1/orgs');
    expect(list.body.data[0]).toMatchObject({
      id: r.body.id,
      membership: { role: { systemKey: 'OWNER' } },
    });
    const events = await ownerQuery<{ type: string }>(
      'SELECT type FROM outbox_events WHERE org_id = $1 ORDER BY id',
      [r.body.id],
    );
    expect(events.map((e) => e.type)).toEqual([
      'tenancy.member.added',
      'tenancy.org.created',
    ]);
  });
  it.each([
    ['😀'.repeat(100), 201],
    ['😀'.repeat(101), 422],
    [' Acme', 422],
    ['Acme ', 422],
    ['\tAcme', 422],
    ['', 422],
  ])(
    'org names are measured in code points like the DB CHECK: %j → %i (Review Focus 1)',
    async (name, status) => {
      const p = await seedP();
      const r = await create(p, { name });
      if (r.status === 201) createdOrgIds.push(r.body.id);
      expect(r.status).toBe(status);
      if (status === 422) expect(r.body.code).toBe('validation_failed');
    },
  );
  it(`T-6: ${RACE_ROUNDS} rounds of two parallel creates at limit − 1 → exactly one 201 and one 422 org_limit_reached`, async () => {
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const p = await seedP();
      for (let k = 0; k < MAX_ORGS - 1; k++)
        createdOrgIds.push((await create(p, { name: `Pre ${k}` })).body.id);
      const [a, b] = await Promise.all([
        create(p, { name: 'A' }),
        create(p, { name: 'B' }),
      ]);
      for (const r of [a, b])
        if (r.status === 201) createdOrgIds.push(r.body.id);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 422]);
      expect([a, b].find((r) => r.status === 422)?.body.code).toBe(
        'org_limit_reached',
      );
    }
  });
  it('creating needs a fresh session and a verified email (sensitive action)', async () => {
    const stale = await seedP({ sessionAgeSec: 3600 });
    expect((await create(stale, { name: 'Old' })).body.code).toBe(
      'reauthentication_required',
    );
    const unverified = await seedP({ emailVerified: false });
    expect((await create(unverified, { name: 'Unv' })).body.code).toBe(
      'email_not_verified',
    );
  });
  it('GET /v1/orgs is an empty page for a new principal and creates no tenancy_users row (Review Focus 2)', async () => {
    const p = await seedP();
    const r = await authed(app, p).get('/v1/orgs');
    expect([r.status, r.body.data, r.body.totalCount]).toEqual([200, [], 0]);
    expect(
      await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [
        p.authUserId,
      ]),
    ).toEqual([]);
  });
  it('includeDeleted lists soft-deleted orgs to owners only and the count matches (Review Focus 3)', async () => {
    const owner = await seedP();
    const member = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}`).expect(204);
    const asOwner = await authed(app, owner).get(
      '/v1/orgs?includeDeleted=true',
    );
    const asMember = await authed(app, member).get(
      '/v1/orgs?includeDeleted=true',
    );
    const ownerIds = asOwner.body.data.map((o: { id: string }) => o.id);
    expect(ownerIds).toContain(org.orgId);
    expect(
      asOwner.body.data.find((o: { id: string }) => o.id === org.orgId)
        .deletedAt,
    ).not.toBeNull();
    expect(asOwner.body.totalCount).toBe(asOwner.body.data.length);
    expect(asMember.body.data.map((o: { id: string }) => o.id)).not.toContain(
      org.orgId,
    );
    expect(asMember.body.totalCount).toBe(asMember.body.data.length);
    expect(
      (await authed(app, owner).get('/v1/orgs')).body.data.map(
        (o: { id: string }) => o.id,
      ),
    ).not.toContain(org.orgId);
  });
  it('If-Match on PATCH: missing 428, W/"n", "n" and * accepted, stale 412 (Review Focus 4)', async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    const url = `/v1/orgs/${org.orgId}`;
    expect(
      (await authed(app, owner).patch(url).send({ name: 'x' })).status,
    ).toBe(428);
    expect(
      (
        await authed(app, owner)
          .patch(url)
          .set('if-match', 'W/"1"')
          .send({ name: 'N2' })
      ).status,
    ).toBe(200);
    expect(
      (
        await authed(app, owner)
          .patch(url)
          .set('if-match', '"2"')
          .send({ name: 'N3' })
      ).status,
    ).toBe(200);
    expect(
      (
        await authed(app, owner)
          .patch(url)
          .set('if-match', '*')
          .send({ name: 'N4' })
      ).status,
    ).toBe(200);
    expect(
      (
        await authed(app, owner)
          .patch(url)
          .set('if-match', 'W/"1"')
          .send({ name: 'N5' })
      ).status,
    ).toBe(412);
    const got = await authed(app, owner).get(url);
    expect([got.body.name, got.headers['etag']]).toEqual(['N4', 'W/"4"']);
  });
  it('concurrent renames with the same ETag: one 200, one 412 (Review Focus 4)', async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    const url = `/v1/orgs/${org.orgId}`;
    const [a, b] = await Promise.all([
      authed(app, owner)
        .patch(url)
        .set('if-match', 'W/"1"')
        .send({ name: 'Left' }),
      authed(app, owner)
        .patch(url)
        .set('if-match', 'W/"1"')
        .send({ name: 'Right' }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 412]);
  });
  it('members read but cannot rename; admins cannot delete (ownerOnly)', async () => {
    const owner = await seedP();
    const admin = await seedP();
    const member = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    expect(
      (await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status,
    ).toBe(200);
    expect(
      (
        await authed(app, member)
          .patch(`/v1/orgs/${org.orgId}`)
          .set('if-match', '*')
          .send({ name: 'no' })
      ).status,
    ).toBe(403);
    expect(
      (await authed(app, admin).delete(`/v1/orgs/${org.orgId}`)).status,
    ).toBe(403);
  });
  it('GET /v1/permissions lists the merged, non-deprecated catalogue', async () => {
    const p = await seedP();
    const r = await authed(app, p).get('/v1/permissions');
    expect(r.status).toBe(200);
    const expected = [...app.get(PermissionCatalogueRegistry).merged().values()]
      .filter((e) => !e.deprecated)
      .map((e) => e.key)
      .sort();
    expect(r.body.data.map((x: { key: string }) => x.key).sort()).toEqual(
      expected,
    );
    expect(expected).toContain('entitlements.read');
    expect(
      r.body.data.find((x: { key: string }) => x.key === 'org.delete'),
    ).toMatchObject({
      ownerOnly: true,
      requires: ['org.read'],
    });
    expect(
      (await request(app.getHttpServer()).get('/v1/permissions')).status,
    ).toBe(401);
  });
  it('route inventory + catalogue check stay under 200 ms (tiêu chí 17)', async () => {
    const started = performance.now();
    expect(app.get(OrgRouteInventory).check()).toEqual([]);
    await app.get(CatalogueCheck).onModuleInit();
    expect(performance.now() - started).toBeLessThan(BOOT_CHECK_BUDGET_MS);
  });
});
