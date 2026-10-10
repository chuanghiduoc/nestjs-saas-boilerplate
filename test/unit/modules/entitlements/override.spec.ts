import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_VALUE_MAX,
  REASON_MAX_LENGTH,
} from '../../../../src/modules/entitlements/constants.js';
import {
  UNLIMITED,
  featureCatalogueData,
  mergeFeatureCatalogues,
  type FeatureEntry,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  decideOverrideValue,
  isReason,
  sameOverride,
  type OverrideRequest,
} from '../../../../src/modules/entitlements/domain/override.js';
import {
  OverrideRemovedEvent,
  OverrideSetEvent,
} from '../../../../src/modules/entitlements/events.js';

const ORG = '0198c000-0000-7000-8000-00000000000e';
const merged = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 3 } },
  }),
]);
const f = (key: string): FeatureEntry => {
  const e = merged.get(key);
  if (!e) throw new Error(`no feature ${key}`);
  return e;
};

describe('decideOverrideValue (spec SP4 §12.2: value of the kind, within [minimum, 2^53 − 1] or null)', () => {
  it.each<[string, OverrideRequest, unknown]>([
    ['x.flag', { enabled: true }, { kind: 'FLAG', enabled: true }],
    ['x.seats', { limit: 1 }, { kind: 'LIMIT', limit: 1 }],
    ['x.seats', { limit: null }, { kind: 'LIMIT', limit: null }],
    [
      'x.seats',
      { limit: ENTITLEMENT_VALUE_MAX },
      { kind: 'LIMIT', limit: ENTITLEMENT_VALUE_MAX },
    ],
    ['x.calls', { limit: 0 }, { kind: 'QUOTA', limit: 0 }],
  ])('%s %j → accepted as %j', (key, input, value) => {
    expect(decideOverrideValue(f(key), input)).toEqual({ ok: true, value });
  });
  it.each<[string, OverrideRequest, string, string]>([
    ['x.flag', { limit: 3 }, 'limit', 'invalid_value'],
    ['x.flag', { limit: null }, 'limit', 'invalid_value'],
    ['x.seats', { enabled: true }, 'enabled', 'invalid_value'],
    ['x.seats', { limit: 0 }, 'limit', 'too_small'],
    ['x.seats', { limit: 1.5 }, 'limit', 'invalid_value'],
    ['x.seats', { limit: 2 ** 53 }, 'limit', 'invalid_value'],
    ['x.calls', { limit: -1 }, 'limit', 'too_small'],
  ])('%s %j → refused on %s (%s)', (key, input, path, code) => {
    const d = decideOverrideValue(f(key), input);
    expect(d.ok ? undefined : [d.problem.path, d.problem.code]).toEqual([
      path,
      code,
    ]);
  });
});

describe('isReason (the CHECK of the database: trimmed, 1–500 code points)', () => {
  it.each<[string, boolean]>([
    ['goodwill', true],
    ['😀'.repeat(REASON_MAX_LENGTH), true],
    ['😀'.repeat(REASON_MAX_LENGTH + 1), false],
    ['x'.repeat(REASON_MAX_LENGTH + 1), false],
    ['', false],
    [' goodwill', false],
    ['goodwill\n', false],
  ])('%j → %s', (r, ok) => {
    expect(isReason(r)).toBe(ok);
  });
});

describe('sameOverride (PUT idempotent, RFC 9110 §13.1.1)', () => {
  const at = new Date('2026-12-01T00:00:00.000Z');
  const stored = {
    flagValue: null,
    limitValue: 4,
    reason: 'promo',
    expiresAt: at,
  };
  it('equal value, reason and expiry → same; any difference → not the same', () => {
    expect(
      sameOverride(
        stored,
        { kind: 'LIMIT', limit: 4 },
        'promo',
        new Date(at.getTime()),
      ),
    ).toBe(true);
    expect(sameOverride(stored, { kind: 'LIMIT', limit: 5 }, 'promo', at)).toBe(
      false,
    );
    expect(sameOverride(stored, { kind: 'LIMIT', limit: 4 }, 'other', at)).toBe(
      false,
    );
    expect(
      sameOverride(stored, { kind: 'LIMIT', limit: 4 }, 'promo', null),
    ).toBe(false);
    expect(
      sameOverride(
        { ...stored, limitValue: null, flagValue: true },
        { kind: 'FLAG', enabled: true },
        'promo',
        at,
      ),
    ).toBe(true);
  });
});

describe('override events (spec SP4 §13.1, R-X31)', () => {
  it('both are audited and never webhooks; the staff reason is required and follows the reason rule', () => {
    expect([
      OverrideSetEvent.audit,
      OverrideSetEvent.webhook,
      OverrideRemovedEvent.audit,
      OverrideRemovedEvent.webhook,
    ]).toEqual([true, false, true, false]);
    const set = {
      orgId: ORG,
      feature: 'x.flag',
      value: { kind: 'FLAG', enabled: true },
      expiresAt: null,
    };
    expect(OverrideSetEvent.schema.safeParse(set).success).toBe(false);
    expect(
      OverrideSetEvent.schema.safeParse({ ...set, reason: 'pilot' }).success,
    ).toBe(true);
    expect(
      OverrideSetEvent.schema.safeParse({ ...set, reason: ' padded' }).success,
    ).toBe(false);
    expect(
      OverrideRemovedEvent.schema.safeParse({ orgId: ORG, feature: 'x.flag' })
        .success,
    ).toBe(false);
    expect(
      OverrideRemovedEvent.schema.safeParse({
        orgId: ORG,
        feature: 'x.flag',
        reason: 'cleanup',
      }).success,
    ).toBe(true);
  });
});
