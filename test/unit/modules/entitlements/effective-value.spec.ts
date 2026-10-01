import { describe, expect, it } from 'vitest';
import {
  UNLIMITED,
  type FeatureEntry,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  InvalidEntitlementValueError,
  overrideStatus,
  quotaState,
  resolveEffective,
  type OverrideInput,
} from '../../../../src/modules/entitlements/domain/effective-value.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const LATER = new Date('2026-10-02T00:00:00.000Z');
const EARLIER = new Date('2026-09-30T00:00:00.000Z');
const flag: FeatureEntry = {
  key: 'x.flag',
  kind: 'FLAG',
  fallback: false,
  deprecated: false,
};
const limit: FeatureEntry = {
  key: 'x.seats',
  kind: 'LIMIT',
  fallback: UNLIMITED,
  minimum: 1,
  deprecated: false,
};
const quota: FeatureEntry = {
  key: 'x.calls',
  kind: 'QUOTA',
  resetPeriod: 'MONTH',
  fallback: { max: 5 },
  minimum: 0,
  deprecated: false,
};
const ov = (o: Partial<OverrideInput>): OverrideInput => ({
  flagValue: null,
  limitValue: null,
  expiresAt: null,
  ...o,
});

describe('resolveEffective (spec SP4 §8.4, EV-1…EV-9)', () => {
  it.each([
    [
      'live override',
      ov({ flagValue: true, expiresAt: LATER }),
      false,
      { kind: 'FLAG', enabled: true, source: 'OVERRIDE' },
    ],
    [
      'permanent override',
      ov({ flagValue: true }),
      false,
      { kind: 'FLAG', enabled: true, source: 'OVERRIDE' },
    ],
    [
      'expired override falls back to the plan',
      ov({ flagValue: true, expiresAt: EARLIER }),
      false,
      { kind: 'FLAG', enabled: false, source: 'PLAN' },
    ],
    [
      'plan only',
      undefined,
      true,
      { kind: 'FLAG', enabled: true, source: 'PLAN' },
    ],
  ] as const)('EV-1 FLAG: %s', (_, o, planValue, expected) => {
    expect(resolveEffective(flag, planValue, o, NOW)).toEqual(expected);
  });
  it('EV-2 FLAG: fallback when neither plan nor override mention it', () => {
    expect(resolveEffective(flag, undefined, undefined, NOW)).toEqual({
      kind: 'FLAG',
      enabled: false,
      source: 'FALLBACK',
    });
  });
  it.each([
    [
      'live override MAX',
      ov({ limitValue: 3, expiresAt: LATER }),
      { max: 10 },
      { kind: 'LIMIT', limit: { kind: 'MAX', max: 3 }, source: 'OVERRIDE' },
    ],
    [
      'live override NULL = unlimited',
      ov({ limitValue: null }),
      { max: 10 },
      { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'OVERRIDE' },
    ],
    [
      'expired override',
      ov({ limitValue: 3, expiresAt: EARLIER }),
      { max: 10 },
      { kind: 'LIMIT', limit: { kind: 'MAX', max: 10 }, source: 'PLAN' },
    ],
    [
      'plan UNLIMITED',
      undefined,
      UNLIMITED,
      { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'PLAN' },
    ],
    [
      'fallback UNLIMITED',
      undefined,
      undefined,
      { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'FALLBACK' },
    ],
  ] as const)('EV-3/EV-4 LIMIT: %s', (_, o, planValue, expected) => {
    expect(resolveEffective(limit, planValue, o, NOW)).toEqual(expected);
  });
  it.each([
    [
      'override',
      ov({ limitValue: 7 }),
      undefined,
      { kind: 'MAX', max: 7 },
      'OVERRIDE',
    ],
    ['plan', undefined, { max: 100 }, { kind: 'MAX', max: 100 }, 'PLAN'],
    ['fallback', undefined, undefined, { kind: 'MAX', max: 5 }, 'FALLBACK'],
  ] as const)(
    'EV-5 QUOTA keeps its reset period: %s',
    (_, o, planValue, lim, source) => {
      expect(resolveEffective(quota, planValue, o, NOW)).toEqual({
        kind: 'QUOTA',
        limit: lim,
        resetPeriod: 'MONTH',
        source,
      });
    },
  );
  it('EV-6: a value of the wrong type for the kind fails loud (the boot check should have caught it)', () => {
    expect(() => resolveEffective(flag, { max: 1 }, undefined, NOW)).toThrow(
      InvalidEntitlementValueError,
    );
    expect(() => resolveEffective(limit, true, undefined, NOW)).toThrow(
      InvalidEntitlementValueError,
    );
    expect(() =>
      resolveEffective(flag, undefined, ov({ limitValue: 1 }), NOW),
    ).toThrow(InvalidEntitlementValueError);
    expect(() =>
      resolveEffective(limit, undefined, ov({ flagValue: true }), NOW),
    ).toThrow(InvalidEntitlementValueError);
  });
  it('EV-7 overrideStatus: expired exactly at expires_at (boundary is >), permanent when NULL', () => {
    expect(overrideStatus(null, NOW)).toBe('ACTIVE');
    expect(overrideStatus(new Date(NOW.getTime() + 1), NOW)).toBe('ACTIVE');
    expect(overrideStatus(new Date(NOW.getTime()), NOW)).toBe('EXPIRED');
    expect(overrideStatus(EARLIER, NOW)).toBe('EXPIRED');
  });
  it.each([
    [{ kind: 'UNLIMITED' }, 1_000_000, 'WITHIN'],
    [{ kind: 'MAX', max: 10 }, 9, 'WITHIN'],
    [{ kind: 'MAX', max: 10 }, 10, 'REACHED'],
    [{ kind: 'MAX', max: 10 }, 11, 'OVER_LIMIT'],
    [{ kind: 'MAX', max: 0 }, 0, 'REACHED'],
  ] as const)('EV-8/EV-9 quotaState(%j, %i) = %s', (lim, used, state) => {
    expect(quotaState(lim, used)).toBe(state);
  });
});
