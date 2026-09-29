import { Injectable, Module } from '@nestjs/common';
import { FeatureCatalogueContributor } from '../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { UNLIMITED } from '../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../src/modules/entitlements/domain/plan-catalogue.js';
import { defineFeatureCatalogue } from '../../src/modules/entitlements/http/decorators.js';
import { featureRowsOf, seedFeatures, seedPlans } from './entitlements-seed.js';

/** Catalogue fixture đủ ba loại, hai kỳ, một key deprecated (spec SP4 §20 "catalogue fixture"). */
export const FixtureFeatures = defineFeatureCatalogue({
  'fixture.reports': { kind: 'FLAG', fallback: false },
  'fixture.exports': { kind: 'FLAG', fallback: true },
  'fixture.projects': { kind: 'LIMIT', fallback: { max: 2 } },
  'fixture.api_calls': {
    kind: 'QUOTA',
    resetPeriod: 'MONTH',
    fallback: { max: 100 },
  },
  'fixture.legacy_pdf': { kind: 'FLAG', fallback: false, deprecated: true },
});
@Injectable()
@FeatureCatalogueContributor(FixtureFeatures)
class FixtureFeaturesContributor {}
@Module({ providers: [FixtureFeaturesContributor] })
export class FixtureFeaturesModule {}

/** `free`/`pro` trùng key của migration mẫu (Task 8) nên catalogue check đạt cả khi DB đã có hai dòng đó. */
export const fixturePlans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: {
    free: { values: {} },
    pro: {
      values: {
        'fixture.reports': true,
        'fixture.exports': false,
        'fixture.projects': UNLIMITED,
        'tenancy.seats': { max: 10 },
      },
    },
    enterprise: { values: { 'fixture.reports': true } },
    legacy: { retired: true, values: { 'fixture.reports': true } },
  },
});

/**
 * Chèn đúng các dòng DB mà `FixtureFeatures` + `fixturePlans` đòi (phép so của catalogue check, Task 8). Gọi TRƯỚC khi
 * dựng app; hàm dọn gọi SAU khi mọi org dùng các gói đó đã dispose (FK RESTRICT).
 */
export async function seedFixtureCatalogue(): Promise<() => Promise<void>> {
  const disposeFeatures = await seedFeatures(featureRowsOf(FixtureFeatures));
  const disposePlans = await seedPlans(
    [...fixturePlans.plans.values()].map((p) => ({
      key: p.key,
      retired: p.retired,
    })),
  );
  return async () => {
    await disposePlans();
    await disposeFeatures();
  };
}
