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
  seedStaffPrincipal,
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
  apiKeyEligibleKeys,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  seedTransfer,
  supportPresetKeys,
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
/** Route tenant của 3C (spec §12). */
const ROUTES_3C = [
  'GET v1/orgs/:orgId/invitations',
  'POST v1/orgs/:orgId/invitations',
  'DELETE v1/orgs/:orgId/invitations/:invitationId',
  'GET v1/orgs/:orgId/invite-links',
  'POST v1/orgs/:orgId/invite-links',
  'DELETE v1/orgs/:orgId/invite-links/:linkId',
  'GET v1/orgs/:orgId/ownership-transfers',
  'POST v1/orgs/:orgId/ownership-transfers',
  'POST v1/orgs/:orgId/ownership-transfers/:transferId/accept',
  'POST v1/orgs/:orgId/ownership-transfers/:transferId/decline',
  'DELETE v1/orgs/:orgId/ownership-transfers/:transferId',
];
/** Route tenant của 3D (spec §12). */
const ROUTES_3D = [
  'POST v1/orgs/:orgId/api-keys',
  'GET v1/orgs/:orgId/api-keys',
  'GET v1/orgs/:orgId/api-keys/mine',
  'DELETE v1/orgs/:orgId/api-keys/mine/:keyId',
  'DELETE v1/orgs/:orgId/api-keys/:keyId',
  'GET v1/orgs/:orgId/support-grants',
  'POST v1/orgs/:orgId/support-grants',
  'DELETE v1/orgs/:orgId/support-grants/:grantId',
];
/** Spec §18.3 G-6: thêm cột org key đủ phạm vi (`KEY`) và support grant đã step-up (`SUPPORT`). */
type Column = SystemRoleKey | 'C1' | 'KEY' | 'SUPPORT';
const COLUMNS: readonly Column[] = [
  'OWNER',
  'ADMIN',
  'MEMBER',
  'C1',
  'KEY',
  'SUPPORT',
];
type Caller = { bearer: string } | { apiKey: string };
const STALE_SEC = 3600;

type Cast = {
  org: SeededOrg;
  as: Record<SystemRoleKey | 'C1' | 'SUPPORT', SeededPrincipal>;
  /** Org key do OWNER tạo, phạm vi = mọi quyền api-key-eligible của catalogue gộp. */
  keyToken: string;
  target: string;
  targetP: SeededPrincipal;
  role: string;
  invitation: string;
  link: string;
  transfer: string;
  key: string;
  grant: string;
  staff: SeededPrincipal;
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
  'POST v1/orgs/:orgId/ownership-transfers/:transferId/decline': {
    as: (c) => c.targetP,
    status: 200,
  },
  'DELETE v1/orgs/:orgId/ownership-transfers/:transferId': {
    as: (c) => c.as.OWNER,
    status: 204,
  },
  // `c.key` do OWNER tạo nên OWNER thu hồi được qua cả hai route.
  'DELETE v1/orgs/:orgId/api-keys/mine/:keyId': {
    as: (c) => c.as.OWNER,
    status: 204,
  },
  'DELETE v1/orgs/:orgId/api-keys/:keyId': {
    as: (c) => c.as.OWNER,
    status: 204,
  },
  'DELETE v1/orgs/:orgId/support-grants/:grantId': {
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
    const transfer = await seedTransfer(org, {
      fromMemberId: org.owner.memberId,
      toMemberId: target.memberId,
    });
    const key = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    const grant = await seedSupportGrant(org, {
      grantee: { externalSubject: `matrix:${v7()}` },
      grantedByMemberId: org.owner.memberId,
      permissions: supportPresetKeys(
        app.get(PermissionCatalogueRegistry).merged(),
      ),
    });
    // Nhân viên có factor + dấu step-up, không là member: POST support-grants đi tới cuối ở các ô được phép.
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const fullKey = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: apiKeyEligibleKeys(merged),
    });
    // Cột SUPPORT: một nhân viên khác, có grant preset đang mở và dấu step-up tươi.
    const supportP = await seedStaffPrincipal();
    principals.push(supportP);
    await seedSupportGrant(org, {
      grantee: { authUserId: supportP.authUserId },
      grantedByMemberId: org.owner.memberId,
      permissions: supportPresetKeys(merged),
    });
    return {
      org,
      as: {
        OWNER: owner,
        ADMIN: admin,
        MEMBER: member,
        C1: c1p,
        SUPPORT: supportP,
      },
      keyToken: fullKey.token,
      target: target.memberPublicId,
      targetP,
      role: spare.publicId,
      invitation: invitation.publicId,
      link: link.publicId,
      transfer: transfer.publicId,
      key: key.publicId,
      grant: grant.publicId,
      staff,
    };
  };
  const call = (route: TenantRoute, c: Cast, caller: Caller) => {
    const url = `/${route.template}`
      .replace(':orgId', c.org.orgId)
      .replace(':memberId', c.target)
      .replace(':roleId', c.role)
      .replace(':invitationId', c.invitation)
      .replace(':linkId', c.link)
      .replace(':transferId', c.transfer)
      .replace(':keyId', c.key)
      .replace(':grantId', c.grant);
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
                  : route.id === 'POST v1/orgs/:orgId/ownership-transfers'
                    ? { toMemberId: c.target, stepDownTo: null }
                    : route.id === 'POST v1/orgs/:orgId/api-keys'
                      ? {
                          name: 'matrix',
                          permissions: ['org.read'],
                          expiresInSec: 3600,
                        }
                      : route.id === 'POST v1/orgs/:orgId/support-grants'
                        ? {
                            staffUserId: c.staff.authUserId,
                            expiresInSec: 900,
                            reason: 'matrix',
                          }
                        : {};
    const [header, value] =
      'apiKey' in caller
        ? ['x-api-key', caller.apiKey]
        : ['authorization', `Bearer ${caller.bearer}`];
    const req = agent[method](url)
      .set(header, value)
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

  it('the tenant route table of 3A, 3B, 3C and 3D is exactly the one in the spec', () => {
    expect(routes.map((r) => r.id).sort()).toEqual(
      [...ROUTES_3A, ...ROUTES_3B, ...ROUTES_3C, ...ROUTES_3D].sort(),
    );
  });
  it('G-6: every (OWNER|ADMIN|MEMBER|C1|KEY|SUPPORT × route) cell passes the guard iff the catalogue grants every required key', async () => {
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const failures: string[] = [];
    for (const column of COLUMNS) {
      const perms =
        column === 'KEY'
          ? new Set(apiKeyEligibleKeys(merged))
          : column === 'SUPPORT'
            ? new Set(supportPresetKeys(merged))
            : column === 'C1'
              ? new Set(roleSetC1(merged))
              : systemRolePermissions(column, merged);
      const delegated = column === 'KEY' || column === 'SUPPORT';
      for (const route of routes) {
        // Org key bị `@SessionOnly` (route ✓ và route thu hẹp) và `@OrgMemberOnly` từ chối; support grant bị `@OrgMemberOnly` từ chối.
        const sessionOnly = route.sensitive || route.narrowing;
        const allowed =
          route.policy.kind === 'MEMBER_ONLY'
            ? !delegated
            : route.policy.keys.every((k) => perms.has(k)) &&
              !(column === 'KEY' && sessionOnly);
        const c = await cast();
        const r = await call(
          route,
          c,
          column === 'KEY' ? { apiKey: c.keyToken } : c.as[column],
        );
        // Hai cột mới so `403` bất kỳ mã: org key ở route `@SessionOnly` nhận `api_key_not_allowed_here` từ `AuthGuard`.
        const deniedByGuard = delegated
          ? r.status === 403
          : r.status === 403 && r.body.code === 'forbidden';
        if (r.status >= 500 || deniedByGuard === allowed)
          failures.push(
            `${column} ${route.id}: ${r.status} ${r.body.code ?? ''} (expected ${allowed ? 'past the guard' : '403 forbidden'})`,
          );
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
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
