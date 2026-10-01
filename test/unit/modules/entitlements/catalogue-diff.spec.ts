import { describe, expect, it } from 'vitest';
import { entitlementsCatalogueDiff } from '../../../../src/modules/entitlements/application/catalogue-check.js';
import {
  UNLIMITED,
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import type {
  FeatureRow,
  PlanRow,
} from '../../../../src/modules/entitlements/ports/catalogue.reader.js';

const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: UNLIMITED },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
  }),
]);
const plans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: { free: { values: {} }, legacy: { retired: true, values: {} } },
});
const featureRows: FeatureRow[] = [
  { key: 'x.flag', kind: 'FLAG', resetPeriod: null, deprecated: false },
  { key: 'x.calls', kind: 'QUOTA', resetPeriod: 'MONTH', deprecated: false },
  { key: 'x.old', kind: 'FLAG', resetPeriod: null, deprecated: true },
];
const planRows: PlanRow[] = [
  { key: 'free', retired: false },
  { key: 'legacy', retired: true },
];

describe('entitlementsCatalogueDiff (spec SP4 §8.3, EC-9)', () => {
  it('identical code and rows → no difference', () => {
    expect(
      entitlementsCatalogueDiff(features, featureRows, plans, planRows),
    ).toEqual([]);
  });
  it('lists every difference by key and attribute, features then plans, sorted', () => {
    const fr: FeatureRow[] = [
      { key: 'x.flag', kind: 'LIMIT', resetPeriod: null, deprecated: false },
      { key: 'x.calls', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false },
      { key: 'x.ghost', kind: 'FLAG', resetPeriod: null, deprecated: false },
    ];
    const pr: PlanRow[] = [
      { key: 'legacy', retired: false },
      { key: 'gold', retired: false },
    ];
    expect(entitlementsCatalogueDiff(features, fr, plans, pr)).toEqual([
      'feature x.calls: resetPeriod code=MONTH db=NONE',
      'feature x.flag: kind code=FLAG db=LIMIT',
      'feature x.ghost: in the database, missing in code',
      'feature x.old: in code, missing in the database',
      'plan free: in code, missing in the database',
      'plan gold: in the database, missing in code',
      'plan legacy: retired code=true db=false',
    ]);
    expect(
      entitlementsCatalogueDiff(
        features,
        [
          ...featureRows.slice(0, 2),
          { key: 'x.old', kind: 'FLAG', resetPeriod: null, deprecated: false },
        ],
        plans,
        planRows,
      ),
    ).toEqual(['feature x.old: deprecated code=true db=false']);
  });
});
