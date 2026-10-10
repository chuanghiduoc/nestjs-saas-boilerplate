import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OrgRouteInventory,
  type TenantRoute,
} from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { systemRolePermissions } from '../../../src/modules/tenancy/domain/system-roles.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  apiKeyEligibleKeys,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

type Column = 'OWNER' | 'ADMIN' | 'MEMBER' | 'KEY' | 'SUPPORT';
const COLUMNS: readonly Column[] = [
  'OWNER',
  'ADMIN',
  'MEMBER',
  'KEY',
  'SUPPORT',
];

describe('role × route matrix of the 6C routes (spec SP3 G-6 generated from metadata, SP6 §9.1, S6-A35)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let routes: TenantRoute[];
  const people: SeededPrincipal[] = [];
  const as: Partial<Record<Exclude<Column, 'KEY'>, SeededPrincipal>> = {};
  let keyToken = '';
  beforeAll(async () => {
    app = await startIntegrationsApp();
    routes = app
      .get(OrgRouteInventory)
      .tenantRoutes()
      .filter((r) => /webhook-(endpoints|deliveries)/.test(r.template));
    const owner = await seedUserPrincipal();
    const admin = await seedUserPrincipal();
    const member = await seedUserPrincipal();
    const support = await seedStaffPrincipal();
    people.push(owner, admin, member, support);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    const merged = app.get(PermissionCatalogueRegistry).merged();
    keyToken = (
      await seedOrgApiKey(org, {
        createdByMemberId: org.owner.memberId,
        permissions: apiKeyEligibleKeys(merged),
      })
    ).token;
    await seedSupportGrant(org, {
      grantee: { authUserId: support.authUserId },
      grantedByMemberId: org.owner.memberId,
      permissions: supportPresetKeys(merged),
    });
    Object.assign(as, {
      OWNER: owner,
      ADMIN: admin,
      MEMBER: member,
      SUPPORT: support,
    });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals(people);
  });

  it('lists every route of spec §9.2 for 6C', () => {
    expect(routes.map((r) => r.id).sort()).toEqual(
      [
        'GET v1/orgs/:orgId/webhook-endpoints',
        'POST v1/orgs/:orgId/webhook-endpoints',
        'GET v1/orgs/:orgId/webhook-endpoints/:endpointId',
        'PATCH v1/orgs/:orgId/webhook-endpoints/:endpointId',
        'PATCH v1/orgs/:orgId/webhook-endpoints/:endpointId/destination',
        'DELETE v1/orgs/:orgId/webhook-endpoints/:endpointId',
        'POST v1/orgs/:orgId/webhook-endpoints/:endpointId/rotate-secret',
        'POST v1/orgs/:orgId/webhook-endpoints/:endpointId/test',
        'POST v1/orgs/:orgId/webhook-endpoints/:endpointId/recover',
        'GET v1/orgs/:orgId/webhook-endpoints/:endpointId/deliveries',
        'GET v1/orgs/:orgId/webhook-deliveries/:deliveryId',
        'POST v1/orgs/:orgId/webhook-deliveries/:deliveryId/retry',
      ].sort(),
    );
  });
  it('every (column × route) cell passes the guard iff the catalogue grants every key; an org key never creates or edits an endpoint (S6-A35)', async () => {
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const failures: string[] = [];
    const passed: Record<Column, string[]> = {
      OWNER: [],
      ADMIN: [],
      MEMBER: [],
      KEY: [],
      SUPPORT: [],
    };
    for (const column of COLUMNS) {
      const perms =
        column === 'KEY'
          ? new Set(apiKeyEligibleKeys(merged))
          : column === 'SUPPORT'
            ? new Set(supportPresetKeys(merged))
            : systemRolePermissions(column, merged);
      for (const route of routes) {
        if (route.policy.kind !== 'PERMISSIONS')
          throw new Error(`${route.id}: expected a permission policy`);
        const allowed = route.policy.keys.every((k) => perms.has(k));
        const url = `/${route.template.replace(':orgId', org.orgId).replace(':endpointId', v7()).replace(':deliveryId', v7())}`;
        const agent = request(app.getHttpServer());
        const m = route.method.toLowerCase() as
          'get' | 'post' | 'patch' | 'delete';
        const auth: [string, string] =
          column === 'KEY'
            ? ['x-api-key', keyToken]
            : ['authorization', `Bearer ${as[column]?.bearer ?? ''}`];
        const req = agent[m](url)
          .set(auth[0], auth[1])
          .set('if-match', '*')
          .set('idempotency-key', `k-${v7()}`);
        const r = m === 'get' ? await req : await req.send({});
        // Qua guard thì gặp 404/422 (id ngẫu nhiên, body rỗng); bị chặn thì 403 (org key ở route @SessionOnly: api_key_not_allowed_here).
        const denied = r.status === 403;
        if (!denied) passed[column].push(route.id);
        if (r.status >= 500 || denied === allowed)
          failures.push(
            `${column} ${route.id}: ${r.status} ${r.body.code ?? ''} (expected ${allowed ? 'past the guard' : '403'})`,
          );
      }
    }
    expect(failures).toEqual([]);
    // Ma trận sinh từ metadata nên tự nhất quán; khẳng định thêm hình dạng mong đợi (S6-A35) để một route ghi bị hạ xuống
    // `webhooks.read` (hoặc một catalogue nới quyền) làm ca đỏ thay vì đổi kỳ vọng theo.
    const all = routes.map((r) => r.id).sort();
    const reads = routes
      .filter((r) => r.method === 'GET')
      .map((r) => r.id)
      .sort();
    expect(passed.OWNER.sort()).toEqual(all);
    expect(passed.ADMIN.sort()).toEqual(all);
    expect(passed.MEMBER).toEqual([]);
    expect(passed.KEY.sort()).toEqual(reads);
    expect(passed.SUPPORT.sort()).toEqual(reads);
  }, 120_000);
});
