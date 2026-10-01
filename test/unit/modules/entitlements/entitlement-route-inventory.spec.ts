import {
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';
import {
  ENTITLEMENT_PLANS,
  EntitlementCatalogueRegistry,
  FeatureCatalogueContributor,
} from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { EntitlementRouteInventory } from '../../../../src/modules/entitlements/application/entitlement-route-inventory.js';
import { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import { UNLIMITED } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import { FEATURE_REQUIREMENTS } from '../../../../src/modules/entitlements/http/feature-metadata.js';

const Fx = defineFeatureCatalogue({
  'fx.flag': { kind: 'FLAG', fallback: true },
  'fx.old': { kind: 'FLAG', fallback: true, deprecated: true },
  'fx.limit': { kind: 'LIMIT', fallback: UNLIMITED },
});
const Unregistered = defineFeatureCatalogue({
  'un.flag': { kind: 'FLAG', fallback: true },
});
@Injectable()
@FeatureCatalogueContributor(Fx)
class FxContributor {}

@Controller('v1/orgs/:orgId/good')
class Good {
  @Get() @Fx.requireEnabled('fx.flag') list() {}
}
@Controller('v1/orgs/:orgId/good-class')
@Fx.requireEnabled('fx.flag')
class GoodClass {
  @Get() list() {}
}
@Controller('v1/public')
class NotTenant {
  @Get() @Fx.requireEnabled('fx.flag') list() {}
}
@Controller(['v1/orgs/:orgId/mixed', 'v1/mixed'])
class Mixed {
  @Get() @Fx.requireEnabled('fx.flag') list() {}
}
@Controller('v1/orgs/:orgId/deprecated')
class Deprecated {
  @Get() @Fx.requireEnabled('fx.old') list() {}
}
@Controller('v1/orgs/:orgId/unreg')
class NotRegistered {
  @Get() @Unregistered.requireEnabled('un.flag') list() {}
}
/** Metadata viết tay (vượt qua kiểu và kiểm runtime của `requireEnabled`): inventory vẫn phải bắt. */
@Controller('v1/orgs/:orgId/forged')
class Forged {
  @Get('limit') limit(this: void) {}
  @Get('ghost') ghost(this: void) {}
}
Reflect.defineMetadata(
  FEATURE_REQUIREMENTS,
  [{ catalogue: Fx, keys: ['fx.limit'] }],
  Forged.prototype.limit,
);
Reflect.defineMetadata(
  FEATURE_REQUIREMENTS,
  [{ catalogue: Fx, keys: ['fx.ghost'] }],
  Forged.prototype.ghost,
);

/**
 * `requireEnabled` gắn `EntitlementInterceptor` vào controller, nên Nest dựng interceptor trong module fixture và cần deps
 * của nó; inventory chỉ đọc metadata, không bao giờ gọi interceptor, nên giá trị rỗng là đủ.
 */
@Global()
@Module({
  providers: [
    { provide: RequestContext, useValue: {} },
    { provide: Entitlements, useValue: {} },
  ],
  exports: [RequestContext, Entitlements],
})
class InterceptorDeps {}

const plans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: { free: { values: {} } },
});
async function problemsOf(controllers: Type[]): Promise<string[]> {
  @Module({ controllers })
  class Fixture {}
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule, InterceptorDeps, Fixture],
    providers: [
      FxContributor,
      EntitlementCatalogueRegistry,
      EntitlementsMetrics,
      EntitlementRouteInventory,
      { provide: ENTITLEMENT_PLANS, useValue: plans },
    ],
  }).compile();
  ref.get(EntitlementCatalogueRegistry).onModuleInit();
  const problems = ref.get(EntitlementRouteInventory).check();
  await ref.close();
  return problems;
}

describe('EntitlementRouteInventory (spec SP4 §8.3, EC-9 inventory part)', () => {
  it('method-level and class-level requireEnabled on tenant routes pass', async () => {
    expect(await problemsOf([Good, GoodClass])).toEqual([]);
  });
  it.each([
    [
      NotTenant,
      /NotTenant\.list: requireEnabled needs a tenant route under v1\/orgs\/:orgId/,
    ],
    [
      Mixed,
      /Mixed\.list: requireEnabled needs a tenant route under v1\/orgs\/:orgId/,
    ],
    [Deprecated, /Deprecated\.list: "fx\.old" is deprecated/],
    [
      NotRegistered,
      /NotRegistered\.list: its feature catalogue is not registered/,
    ],
    [
      Forged,
      /Forged\.limit: "fx\.limit" is a LIMIT, requireEnabled takes FLAG keys only/,
    ],
    [
      Forged,
      /Forged\.ghost: "fx\.ghost" is not in the merged feature catalogue/,
    ],
  ])('%o refuses to boot', async (ctl, message) => {
    expect((await problemsOf([ctl])).join('\n')).toMatch(message);
  });
});
