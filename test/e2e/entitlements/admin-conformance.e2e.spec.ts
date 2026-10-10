import { afterAll, beforeAll, vi } from 'vitest';
import { AdminEntitlements } from '../../../src/modules/entitlements/application/admin-entitlements.service.js';
import { EntitlementsModule } from '../../../src/modules/entitlements/index.js';
import { examplePlans } from '../../../src/plans.example.js';
import {
  seedOrgEntitlement,
  seedOverride,
} from '../../support/entitlements-seed.js';
import {
  describePlatformStaffActionConformance,
  type ConformanceOptions,
} from '../../support/platform-staff-action.conformance.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

type Mode = 'local' | 'hybrid' | 'external';
type Route = 'view' | 'plan' | 'override' | 'remove';
const MODES: readonly Mode[] = ['local', 'hybrid', 'external'];
const ROUTES: readonly Route[] = ['view', 'plan', 'override', 'remove'];
const IF_MATCH = { 'if-match': 'W/"1"' };

/**
 * Mỗi route × mode một org ở `version` 1: trong bộ ca chỉ C9 tới handler (một lần mỗi mode; C10 và PSA-7 dừng ở port audit,
 * mọi ca khác dừng ở gate), nên `If-Match: W/"1"` đúng đúng lúc nó cần đúng.
 */
const orgs = new Map<string, SeededOrg>();
const orgFor = (route: Route, mode: Mode): string => {
  const o = orgs.get(`${route}:${mode}`);
  if (!o) throw new Error(`conformance org ${route}:${mode} was not seeded`);
  return o.orgId;
};
/**
 * Đếm lần chạy handler cho C9/C10 bằng spy trên prototype của SERVICE mà mỗi route org gọi đúng một lần (spike S4C-2 (b')).
 * KHÔNG spy trên prototype của `AdminEntitlementsController` (review 4C, C1): Nest đọc `PATH_METADATA`/`GUARDS_METADATA`
 * trên chính hàm `prototype[method]`, spy thay hàm đó nên route mất (404) hoặc mất `@PlatformStaffAction()`.
 */
const spies = (
  ['view', 'assignPlan', 'setOverride', 'removeOverride'] as const
).map((m) => vi.spyOn(AdminEntitlements.prototype, m));
const base: ConformanceOptions = {
  extraImports: [EntitlementsModule.forApi(examplePlans)],
  entitlementPermissions: false,
};
const opts: ConformanceOptions = {
  ...base,
  handlerCalls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
};
/**
 * `GET /v1/admin/plans` không gọi service nào riêng (đọc `EntitlementCatalogueRegistry.plans()`, mà snapshot và `assign` cũng
 * gọi): không `handlerCalls` cho route này; C10 vẫn kiểm `503` và port không ghi (chú thích của `ConformanceOptions`).
 */
const plansOpts: ConformanceOptions = base;

beforeAll(async () => {
  for (const route of ROUTES)
    for (const mode of MODES) {
      const o = await seedOrg();
      await seedOrgEntitlement(o.orgId, 'free');
      if (route === 'remove')
        await seedOverride(o.orgId, 'tenancy.seats', { value: { limit: 3 } });
      orgs.set(`${route}:${mode}`, o);
    }
});
afterAll(async () => {
  for (const o of orgs.values()) await o.dispose();
  vi.restoreAllMocks();
});

describePlatformStaffActionConformance(
  'GET /v1/admin/plans',
  () => ({ method: 'GET', path: '/v1/admin/plans', expectAllowedStatus: 200 }),
  plansOpts,
);
describePlatformStaffActionConformance(
  'GET /v1/admin/orgs/{orgId}/entitlements',
  ({ mode }) => ({
    method: 'GET',
    path: `/v1/admin/orgs/${orgFor('view', mode)}/entitlements`,
    expectAllowedStatus: 200,
  }),
  opts,
);
describePlatformStaffActionConformance(
  'PUT /v1/admin/orgs/{orgId}/entitlements/plan',
  ({ mode }) => ({
    method: 'PUT',
    path: `/v1/admin/orgs/${orgFor('plan', mode)}/entitlements/plan`,
    headers: IF_MATCH,
    body: { planKey: 'pro', reason: 'conformance plan' },
    expectAllowedStatus: 200,
  }),
  opts,
);
describePlatformStaffActionConformance(
  'PUT /v1/admin/orgs/{orgId}/entitlements/overrides/{featureKey}',
  ({ mode }) => ({
    method: 'PUT',
    path: `/v1/admin/orgs/${orgFor('override', mode)}/entitlements/overrides/tenancy.seats`,
    headers: IF_MATCH,
    body: { limit: 5, reason: 'conformance override', expiresAt: null },
    expectAllowedStatus: 200,
  }),
  opts,
);
describePlatformStaffActionConformance(
  'DELETE /v1/admin/orgs/{orgId}/entitlements/overrides/{featureKey}',
  ({ mode }) => ({
    method: 'DELETE',
    path: `/v1/admin/orgs/${orgFor('remove', mode)}/entitlements/overrides/tenancy.seats`,
    headers: IF_MATCH,
    body: { reason: 'conformance cleanup' },
    expectAllowedStatus: 204,
  }),
  opts,
);
