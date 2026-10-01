import {
  Controller,
  Get,
  Logger,
  Module,
  type INestApplication,
} from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IdempotencyInterceptor } from '../../../src/core/http/idempotency.interceptor.js';
import { EntitlementCatalogueCheck } from '../../../src/modules/entitlements/application/catalogue-check.js';
import { EntitlementRouteInventory } from '../../../src/modules/entitlements/application/entitlement-route-inventory.js';
import { Entitlements } from '../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementInterceptor } from '../../../src/modules/entitlements/http/entitlement.interceptor.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeatures,
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  seedOrgEntitlement,
  setOrgPlan,
} from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
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
import {
  FeatureGateController,
  FeatureGateModule,
  createdCount,
} from './fixtures/feature-gate.module.js';

/** Vị trí trong mảng interceptor của Nest = thứ tự chạy (phần tử đầu bọc ngoài cùng). */
const runsFirst = (
  handler: 'idemA' | 'idemB',
): 'idempotency' | 'entitlement' => {
  const chain: unknown = Reflect.getMetadata(
    INTERCEPTORS_METADATA,
    FeatureGateController.prototype[handler],
  );
  if (!Array.isArray(chain)) throw new Error(`no interceptors on ${handler}`);
  return chain.indexOf(IdempotencyInterceptor) <
    chain.indexOf(EntitlementInterceptor)
    ? 'idempotency'
    : 'entitlement';
};

/** Route KHÔNG phải tenant có `requireEnabled`: inventory phải chặn boot (dùng ở describe cuối). */
@Controller('v1/public-gate')
class PublicGate {
  @Get()
  @FixtureFeatures.requireEnabled('fixture.reports')
  open() {
    return {};
  }
}
@Module({ controllers: [PublicGate] })
class PublicGateModule {}

describe('requireEnabled on real routes (spec SP4 §6.1, §12.3, S4-D7, HT-1, HT-4)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgOn = async (plan: string) => {
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(o);
    await seedMember(o, 'MEMBER', { authUserId: member.authUserId });
    await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule, FeatureGateModule],
    });
    owner = await seedP();
    member = await seedP();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await disposeCatalogue?.();
  });

  it.each(['guard-first', 'feature-first'])(
    'HT-1 %s: a member lacking the permission gets 403 forbidden and the plan is never read',
    async (route) => {
      const o = await orgOn('free');
      const snapshot = vi.spyOn(Entitlements.prototype, 'snapshot');
      const r = await authed(app, member).get(
        `/v1/orgs/${o.orgId}/fx/${route}`,
      );
      expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
      expect(snapshot).not.toHaveBeenCalled();
      snapshot.mockRestore();
    },
  );
  it.each(['guard-first', 'feature-first'])(
    'HT-1 %s: the owner on a plan without the feature gets 403 feature_not_in_plan naming the key',
    async (route) => {
      const o = await orgOn('free');
      const r = await authed(app, owner).get(`/v1/orgs/${o.orgId}/fx/${route}`);
      expect([r.status, r.body.code]).toEqual([403, 'feature_not_in_plan']);
      expect(r.body.errors).toEqual([
        {
          path: 'feature',
          code: 'fixture.reports',
          message: 'Feature is not included in your plan',
        },
      ]);
    },
  );
  it.each(['guard-first', 'feature-first'])(
    'HT-1 / S4-T1 %s: with the feature the handler runs in the OrgScope of the path org',
    async (route) => {
      const o = await orgOn('pro');
      const r = await authed(app, owner).get(`/v1/orgs/${o.orgId}/fx/${route}`);
      expect([r.status, r.body]).toEqual([
        200,
        { orgId: o.orgId, sqlOrg: o.orgId },
      ]);
    },
  );
  it('HT-4 covers both interceptor orders: idemA and idemB really run idempotency and the feature gate in opposite orders', () => {
    expect(new Set([runsFirst('idemA'), runsFirst('idemB')]).size).toBe(2);
  });
  it.each(['idemA', 'idemB'] as const)(
    'HT-4 %s: the result matches §12.3 for the interceptor order Nest actually runs',
    async (handler) => {
      const o = await orgOn('free');
      const url = `/v1/orgs/${o.orgId}/fx/${handler === 'idemA' ? 'idem-a' : 'idem-b'}`;
      const key = `k-${randomUUID()}`;
      const first = await authed(app, owner)
        .post(url)
        .set('idempotency-key', key)
        .send({});
      expect([first.status, first.body.code]).toEqual([
        403,
        'feature_not_in_plan',
      ]);
      await setOrgPlan(o.orgId, 'pro');
      const before = createdCount();
      const second = await authed(app, owner)
        .post(url)
        .set('idempotency-key', key)
        .send({});
      if (runsFirst(handler) === 'idempotency') {
        // Idempotency bọc ngoài: 403 đã được lưu và trả lại cho cùng key (cha §3.4); handler không chạy.
        expect([second.status, second.body.code, createdCount()]).toEqual([
          403,
          'feature_not_in_plan',
          before,
        ]);
      } else {
        // Cổng tính năng bọc ngoài: 403 không được lưu; sau khi nâng gói, cùng key chạy handler đúng một lần.
        expect([second.status, createdCount()]).toEqual([201, before + 1]);
      }
    },
  );
  it('Review Focus 5: class-level and method-level requireEnabled both apply', async () => {
    const free = await orgOn('free');
    const pro = await orgOn('pro');
    const enterprise = await orgOn('enterprise');
    const call = (o: SeededOrg) =>
      authed(app, owner).get(`/v1/orgs/${o.orgId}/fx-class`);
    const onFree = await call(free);
    expect([onFree.status, onFree.body.errors?.[0]?.code]).toEqual([
      403,
      'fixture.reports',
    ]);
    const onPro = await call(pro);
    expect([onPro.status, onPro.body.errors?.[0]?.code]).toEqual([
      403,
      'fixture.exports',
    ]);
    expect((await call(enterprise)).status).toBe(200);
  });
  it('boot-time checks: route inventory + catalogue check pass on the running app; the duration is logged, not asserted', async () => {
    const started = performance.now();
    expect(app.get(EntitlementRouteInventory).check()).toEqual([]);
    await expect(
      app.get(EntitlementCatalogueCheck).onModuleInit(),
    ).resolves.toBeUndefined();
    // Mốc < 50 ms (spec §20.4) chỉ khẳng định ở smoke trên image thật (Task 13, từ log boot): ở đây DB CI dùng chung, đo
    // thời gian sẽ chập chờn.
    new Logger('require-enabled.e2e').log({
      event: 'entitlements_boot_checks',
      durationMs: Math.round(performance.now() - started),
    });
  });
});

describe('the entitlement route inventory refuses to boot a misplaced requireEnabled (spec SP4 §8.3)', () => {
  it('requireEnabled on a non-tenant route stops the api from starting', async () => {
    const dispose = await seedFixtureCatalogue();
    try {
      await expect(
        startEntitlementsApp(fixturePlans, {
          extraImports: [FixtureFeaturesModule, PublicGateModule],
        }),
      ).rejects.toThrow(
        /PublicGate\.open: requireEnabled needs a tenant route/,
      );
    } finally {
      await dispose();
    }
  });
});
