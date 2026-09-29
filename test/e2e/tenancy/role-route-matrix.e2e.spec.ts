import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OrgRouteInventory,
  type TenantRoute,
} from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import type { SystemRoleKey } from '../../../src/modules/tenancy/constants.js';
import { systemRolePermissions } from '../../../src/modules/tenancy/domain/system-roles.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedMember,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Bảng route tenant của 3A (spec §12); 3B/3C/3D thêm dòng khi thêm route. */
const ROUTES_3A = [
  'DELETE v1/orgs/:orgId',
  'DELETE v1/orgs/:orgId/members/:memberId',
  'DELETE v1/orgs/:orgId/members/me',
  'GET v1/orgs/:orgId',
  'GET v1/orgs/:orgId/members',
  'GET v1/orgs/:orgId/members/:memberId',
  'GET v1/orgs/:orgId/members/me',
  'GET v1/orgs/:orgId/roles',
  'GET v1/orgs/:orgId/roles/:roleId',
  'PATCH v1/orgs/:orgId',
  'PATCH v1/orgs/:orgId/members/:memberId',
  'POST v1/orgs/:orgId/restore',
];
const ROLES: readonly SystemRoleKey[] = ['OWNER', 'ADMIN', 'MEMBER'];
const STALE_SEC = 3600;

type Cast = {
  org: SeededOrg;
  as: Record<SystemRoleKey, SeededPrincipal>;
  target: string;
};

describe('role × route matrix and fresh-session table, generated from route metadata (spec SP3 §18.2, §18.3 G-6)', () => {
  let app: INestApplication;
  let routes: TenantRoute[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** Mỗi ô một org mới: route ghi (xoá org, gỡ member) không làm bẩn ô sau. */
  const cast = async (
    opts: { sessionAgeSec?: number; emailVerified?: boolean } = {},
  ): Promise<Cast> => {
    const owner = await seedP(opts);
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const admin = await seedP(opts);
    const member = await seedP(opts);
    await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await seedMember(org, 'OWNER', { authUserId: (await seedP()).authUserId });
    const target = await seedMember(org, 'MEMBER', {
      authUserId: (await seedP()).authUserId,
    });
    return {
      org,
      as: { OWNER: owner, ADMIN: admin, MEMBER: member },
      target: target.memberPublicId,
    };
  };
  const call = (route: TenantRoute, c: Cast, p: SeededPrincipal) => {
    const url = `/${route.template}`
      .replace(':orgId', c.org.orgId)
      .replace(':memberId', c.target)
      .replace(':roleId', c.org.roles.MEMBER.publicId);
    const agent = request(app.getHttpServer());
    const method = route.method.toLowerCase();
    if (
      method !== 'get' &&
      method !== 'post' &&
      method !== 'patch' &&
      method !== 'delete'
    )
      throw new Error(`matrix: unexpected method ${route.method}`);
    const body =
      route.id === 'PATCH v1/orgs/:orgId'
        ? { name: 'Matrix' }
        : route.id === 'PATCH v1/orgs/:orgId/members/:memberId'
          ? { roleId: c.org.roles.MEMBER.publicId }
          : {};
    const req = agent[method](url)
      .set('authorization', `Bearer ${p.bearer}`)
      .set('if-match', '*')
      .set('idempotency-key', `k-${v7()}`);
    return method === 'get' ? req : req.send(body);
  };
  beforeAll(async () => {
    app = await startTenancyApp({
      env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
    });
    routes = app.get(OrgRouteInventory).tenantRoutes();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('the tenant route table of 3A is exactly the one in the spec', () => {
    expect(routes.map((r) => r.id).sort()).toEqual([...ROUTES_3A].sort());
  });
  it('G-6: every (OWNER|ADMIN|MEMBER × route) cell passes the guard iff the catalogue grants every required key', async () => {
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const failures: string[] = [];
    for (const role of ROLES) {
      const perms = systemRolePermissions(role, merged);
      for (const route of routes) {
        const allowed =
          route.policy.kind === 'MEMBER_ONLY' ||
          route.policy.keys.every((k) => perms.has(k));
        const c = await cast();
        const r = await call(route, c, c.as[role]);
        const deniedByGuard = r.status === 403 && r.body.code === 'forbidden';
        if (r.status >= 500 || deniedByGuard === allowed)
          failures.push(
            `${role} ${route.id}: ${r.status} ${r.body.code ?? ''} (expected ${allowed ? 'past the guard' : '403 forbidden'})`,
          );
      }
    }
    expect(failures).toEqual([]);
  });
  it('every sensitive route: a stale session → 403 reauthentication_required; an unverified email (flag off) → 403 email_not_verified', async () => {
    const failures: string[] = [];
    for (const route of routes.filter((r) => r.sensitive)) {
      const stale = await cast({ sessionAgeSec: STALE_SEC });
      const s = await call(route, stale, stale.as.OWNER);
      if (s.status !== 403 || s.body.code !== 'reauthentication_required')
        failures.push(`stale ${route.id}: ${s.status} ${s.body.code}`);
      const unverified = await cast({ emailVerified: false });
      const u = await call(route, unverified, unverified.as.OWNER);
      if (u.status !== 403 || u.body.code !== 'email_not_verified')
        failures.push(`unverified ${route.id}: ${u.status} ${u.body.code}`);
    }
    expect(failures).toEqual([]);
    const stale = await seedP({ sessionAgeSec: STALE_SEC });
    const create = await request(app.getHttpServer())
      .post('/v1/orgs')
      .set('authorization', `Bearer ${stale.bearer}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'Stale' });
    expect(create.body.code).toBe('reauthentication_required');
  });
  it('every narrowing route succeeds with a stale session (revocation must stay possible, SEC3-2)', async () => {
    const narrowing = routes.filter((r) => r.narrowing);
    expect(narrowing.map((r) => r.id)).toEqual([
      'DELETE v1/orgs/:orgId/members/me',
    ]);
    for (const route of narrowing) {
      const c = await cast({ sessionAgeSec: STALE_SEC });
      expect((await call(route, c, c.as.MEMBER)).status).toBe(204);
    }
  });
});
