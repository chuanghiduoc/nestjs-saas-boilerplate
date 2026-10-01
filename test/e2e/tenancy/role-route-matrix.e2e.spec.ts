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
  ROLE_SET_C0,
  roleSetC1,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedMemberInRole,
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
/** Route tenant của 3B (spec §12). */
const ROUTES_3B = [
  'POST v1/orgs/:orgId/roles',
  'PATCH v1/orgs/:orgId/roles/:roleId',
  'DELETE v1/orgs/:orgId/roles/:roleId',
];
/** Route tenant của 3C (spec §12); Task 10, 11 nối thêm. */
const ROUTES_3C = [
  'GET v1/orgs/:orgId/invitations',
  'POST v1/orgs/:orgId/invitations',
  'DELETE v1/orgs/:orgId/invitations/:invitationId',
  'GET v1/orgs/:orgId/invite-links',
  'POST v1/orgs/:orgId/invite-links',
  'DELETE v1/orgs/:orgId/invite-links/:linkId',
];
type Column = SystemRoleKey | 'C1';
const COLUMNS: readonly Column[] = ['OWNER', 'ADMIN', 'MEMBER', 'C1'];
const STALE_SEC = 3600;

type Cast = {
  org: SeededOrg;
  as: Record<Column, SeededPrincipal>;
  target: string;
  targetP: SeededPrincipal;
  role: string;
  invitation: string;
  link: string;
};
/** Người gọi và status thành công của mỗi route thu hẹp với session CŨ (SEC3-2): rời org là member; thu hồi cần quyền. */
const NARROWING: Record<
  string,
  { as: (c: Cast) => SeededPrincipal; status: number }
> = {
  'DELETE v1/orgs/:orgId/members/me': { as: (c) => c.as.MEMBER, status: 204 },
  'DELETE v1/orgs/:orgId/invitations/:invitationId': {
    as: (c) => c.as.OWNER,
    status: 204,
  },
  'DELETE v1/orgs/:orgId/invite-links/:linkId': {
    as: (c) => c.as.OWNER,
    status: 204,
  },
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
    const targetP = await seedP(opts);
    const target = await seedMember(org, 'MEMBER', {
      authUserId: targetP.authUserId,
    });
    // C1 của catalogue gộp thật (R-X24); cùng hàm với cột C1 của ca G-6 bên dưới.
    const c1 = await seedCustomRole(org, {
      permissions: roleSetC1(app.get(PermissionCatalogueRegistry).merged()),
      name: `C1 ${v7()}`,
    });
    const c1p = await seedP(opts);
    await seedMemberInRole(org, c1, { authUserId: c1p.authUserId });
    // `:roleId` trỏ vào role tuỳ biến chưa ai giữ: route ghi role đi tới cuối (không dừng ở 409 role hệ thống / role_in_use).
    const spare = await seedCustomRole(org, {
      permissions: ROLE_SET_C0,
      name: `Spare ${v7()}`,
    });
    const invitation = await seedInvitation(org, {
      email: `matrix-${v7()}@example.test`,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
    });
    return {
      org,
      as: { OWNER: owner, ADMIN: admin, MEMBER: member, C1: c1p },
      target: target.memberPublicId,
      targetP,
      role: spare.publicId,
      invitation: invitation.publicId,
      link: link.publicId,
    };
  };
  const call = (route: TenantRoute, c: Cast, p: SeededPrincipal) => {
    const url = `/${route.template}`
      .replace(':orgId', c.org.orgId)
      .replace(':memberId', c.target)
      .replace(':roleId', c.role)
      .replace(':invitationId', c.invitation)
      .replace(':linkId', c.link);
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
          : route.id === 'POST v1/orgs/:orgId/roles'
            ? { name: `Matrix ${v7()}`, permissions: ['org.read'] }
            : route.id === 'PATCH v1/orgs/:orgId/roles/:roleId'
              ? { name: `Renamed ${v7()}` }
              : route.id === 'POST v1/orgs/:orgId/invitations'
                ? {
                    email: `matrix-${v7()}@example.test`,
                    roleId: c.org.roles.MEMBER.publicId,
                  }
                : route.id === 'POST v1/orgs/:orgId/invite-links'
                  ? {
                      roleId: c.org.roles.MEMBER.publicId,
                      maxUses: 1,
                      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                    }
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

  it('the tenant route table of 3A, 3B and 3C is exactly the one in the spec', () => {
    expect(routes.map((r) => r.id).sort()).toEqual(
      [...ROUTES_3A, ...ROUTES_3B, ...ROUTES_3C].sort(),
    );
  });
  it('G-6: every (OWNER|ADMIN|MEMBER|C1 × route) cell passes the guard iff the catalogue grants every required key', async () => {
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const failures: string[] = [];
    for (const column of COLUMNS) {
      const perms =
        column === 'C1'
          ? new Set(roleSetC1(merged))
          : systemRolePermissions(column, merged);
      for (const route of routes) {
        const allowed =
          route.policy.kind === 'MEMBER_ONLY' ||
          route.policy.keys.every((k) => perms.has(k));
        const c = await cast();
        const r = await call(route, c, c.as[column]);
        const deniedByGuard = r.status === 403 && r.body.code === 'forbidden';
        if (r.status >= 500 || deniedByGuard === allowed)
          failures.push(
            `${column} ${route.id}: ${r.status} ${r.body.code ?? ''} (expected ${allowed ? 'past the guard' : '403 forbidden'})`,
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
    expect(narrowing.map((r) => r.id).sort()).toEqual(
      Object.keys(NARROWING).sort(),
    );
    for (const route of narrowing) {
      const n = NARROWING[route.id];
      if (!n) throw new Error(`no caller for narrowing route ${route.id}`);
      const c = await cast({ sessionAgeSec: STALE_SEC });
      expect((await call(route, c, n.as(c))).status, route.id).toBe(n.status);
    }
  });
});
