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
  {
    id: '1',
    key: 'x.flag',
    kind: 'FLAG',
    resetPeriod: null,
    deprecated: false,
  },
  {
    id: '2',
    key: 'x.calls',
    kind: 'QUOTA',
    resetPeriod: 'MONTH',
    deprecated: false,
  },
  { id: '3', key: 'x.old', kind: 'FLAG', resetPeriod: null, deprecated: true },
];
const planRows: PlanRow[] = [
  { key: 'free', retired: false },
  { key: 'legacy', retired: true },
];

describe('entitlementsCatalogueDiff (spec SP4 §8.3, EC-9, R-X30)', () => {
  it('identical code and rows → no error, no warning', () => {
    expect(
      entitlementsCatalogueDiff(features, featureRows, plans, planRows),
    ).toEqual({ errors: [], warnings: [] });
  });
  it('errors: missing in the database, kind, resetPeriod, retired in code only; warnings: rows only in the database', () => {
    const fr: FeatureRow[] = [
      {
        id: '1',
        key: 'x.flag',
        kind: 'LIMIT',
        resetPeriod: null,
        deprecated: false,
      },
      {
        id: '2',
        key: 'x.calls',
        kind: 'QUOTA',
        resetPeriod: 'NONE',
        deprecated: false,
      },
      {
        id: '9',
        key: 'x.ghost',
        kind: 'FLAG',
        resetPeriod: null,
        deprecated: false,
      },
    ];
    const pr: PlanRow[] = [
      { key: 'legacy', retired: false },
      { key: 'gold', retired: false },
    ];
    expect(entitlementsCatalogueDiff(features, fr, plans, pr)).toEqual({
      errors: [
        'feature x.calls: resetPeriod code=MONTH db=NONE',
        'feature x.flag: kind code=FLAG db=LIMIT',
        'feature x.old: in code, missing in the database',
        'plan free: in code, missing in the database',
        'plan legacy: retired code=true db=false',
      ],
      warnings: [
        { event: 'entitlement_feature_unknown_to_code', key: 'x.ghost' },
        { event: 'entitlement_plan_unknown_to_code', key: 'gold' },
      ],
    });
  });
  it('deprecated in code but not in the database stays an error (a migration is missing)', () => {
    expect(
      entitlementsCatalogueDiff(
        features,
        [
          ...featureRows.slice(0, 2),
          {
            id: '3',
            key: 'x.old',
            kind: 'FLAG',
            resetPeriod: null,
            deprecated: false,
          },
        ],
        plans,
        planRows,
      ),
    ).toEqual({
      errors: ['feature x.old: deprecated code=true db=false'],
      warnings: [],
    });
  });
  it('deprecated or retired in the database only (a newer release ran its migration) is a warning', () => {
    expect(
      entitlementsCatalogueDiff(
        features,
        [
          {
            id: '1',
            key: 'x.flag',
            kind: 'FLAG',
            resetPeriod: null,
            deprecated: true,
          },
          ...featureRows.slice(1),
        ],
        plans,
        [
          { key: 'free', retired: true },
          { key: 'legacy', retired: true },
        ],
      ),
    ).toEqual({
      errors: [],
      warnings: [
        { event: 'entitlement_feature_deprecated_in_db', key: 'x.flag' },
        { event: 'entitlement_plan_retired_in_db', key: 'free' },
      ],
    });
  });
});
