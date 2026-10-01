import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_VALUE_MAX } from '../../../../src/modules/entitlements/constants.js';
import {
  UNLIMITED,
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  definePlanCatalogue,
  fallbackUsage,
  validatePlanCatalogue,
  type PlanValue,
} from '../../../../src/modules/entitlements/domain/plan-catalogue.js';

const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 0 } },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
  }),
]);
const withValue = (key: string, value: unknown) =>
  definePlanCatalogue({
    defaultPlan: 'free',
    plans: { free: { values: { [key]: value as PlanValue } } },
  });

describe('plan catalogue (spec SP4 §8.2, EC-7, EC-8)', () => {
  it('a valid catalogue has no problem', () => {
    const plans = definePlanCatalogue({
      defaultPlan: 'free',
      plans: {
        free: { values: {} },
        pro: {
          values: {
            'x.flag': true,
            'x.seats': { max: 10 },
            'x.calls': UNLIMITED,
          },
        },
        legacy: { retired: true, values: { 'x.flag': true } },
      },
    });
    expect(validatePlanCatalogue(plans, features)).toEqual([]);
    expect(plans.plans.get('legacy')?.retired).toBe(true);
    expect(plans.plans.get('pro')?.values.get('x.seats')).toEqual({ max: 10 });
  });
  it.each([
    [
      'unknown feature',
      withValue('x.nope', true),
      'plan "free": unknown feature "x.nope"',
    ],
    [
      'deprecated feature',
      withValue('x.old', true),
      'plan "free": feature "x.old" is deprecated',
    ],
    [
      'FLAG given a number',
      withValue('x.flag', { max: 1 }),
      'plan "free": "x.flag" is a FLAG and needs true or false',
    ],
    [
      'LIMIT given a boolean',
      withValue('x.seats', true),
      `plan "free": "x.seats" needs UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`,
    ],
    [
      'below minimum',
      withValue('x.seats', { max: 0 }),
      'plan "free": "x.seats" max 0 is below minimum 1',
    ],
  ])('EC-7: %s', (_, plans, problem) => {
    expect(validatePlanCatalogue(plans, features)).toContain(problem);
  });
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -1])(
    'Review Focus 1: validatePlanCatalogue rejects non-integer, non-finite and out-of-range numbers (%s)',
    (max) => {
      expect(
        validatePlanCatalogue(withValue('x.calls', { max }), features),
      ).toEqual([
        `plan "free": "x.calls" needs UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`,
      ]);
    },
  );
  it('EC-7: bad plan key, missing default plan, retired default plan', () => {
    expect(
      validatePlanCatalogue(
        definePlanCatalogue({
          defaultPlan: 'Free',
          plans: { Free: { values: {} } },
        }),
        features,
      ),
    ).toContain('plan "Free": key must match ^[a-z][a-z0-9_]{0,31}$');
    expect(
      validatePlanCatalogue(
        definePlanCatalogue({
          defaultPlan: 'gold',
          plans: { free: { values: {} } },
        }),
        features,
      ),
    ).toContain('defaultPlan "gold" is not a declared plan');
    expect(
      validatePlanCatalogue(
        definePlanCatalogue({
          defaultPlan: 'free',
          plans: { free: { retired: true, values: {} } },
        }),
        features,
      ),
    ).toContain('defaultPlan "free" is retired');
  });
  it('EC-8: fallbackUsage lists, per plan, the active features the plan does not mention (sorted, deprecated excluded)', () => {
    const plans = definePlanCatalogue({
      defaultPlan: 'free',
      plans: { free: { values: {} }, pro: { values: { 'x.flag': true } } },
    });
    expect(fallbackUsage(plans, features)).toEqual({
      free: ['x.calls', 'x.flag', 'x.seats'],
      pro: ['x.calls', 'x.seats'],
    });
  });
});
