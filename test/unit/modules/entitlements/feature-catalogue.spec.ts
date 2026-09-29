import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_VALUE_MAX,
  FEATURE_KEY_PATTERN,
} from '../../../../src/modules/entitlements/constants.js';
import {
  FeatureCatalogueError,
  UNLIMITED,
  featureCatalogueData,
  featureCatalogueProblems,
  mergeFeatureCatalogues,
  type FeatureDef,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';

/** Dựng catalogue một mục từ giá trị bất kỳ: mô phỏng code JS hoặc cast của dự án vượt qua kiểu. */
const one = (key: string, f: unknown) =>
  featureCatalogueData({ [key]: f as FeatureDef });

describe('feature catalogue (spec SP4 §8.1, EC-1…EC-6)', () => {
  it('a well-formed catalogue of the three kinds merges and is normalised', () => {
    const merged = mergeFeatureCatalogues([
      featureCatalogueData({
        'reports.export': { kind: 'FLAG', fallback: false },
        'reports.scheduled': { kind: 'LIMIT', fallback: { max: 0 } },
        'reports.api_calls': {
          kind: 'QUOTA',
          resetPeriod: 'MONTH',
          fallback: UNLIMITED,
          minimum: 1,
        },
        'reports.legacy_pdf': {
          kind: 'FLAG',
          fallback: false,
          deprecated: true,
        },
      }),
    ]);
    expect(merged.get('reports.export')).toEqual({
      key: 'reports.export',
      kind: 'FLAG',
      fallback: false,
      deprecated: false,
    });
    expect(merged.get('reports.scheduled')).toEqual({
      key: 'reports.scheduled',
      kind: 'LIMIT',
      fallback: { max: 0 },
      minimum: 0,
      deprecated: false,
    });
    expect(merged.get('reports.api_calls')).toEqual({
      key: 'reports.api_calls',
      kind: 'QUOTA',
      resetPeriod: 'MONTH',
      fallback: UNLIMITED,
      minimum: 1,
      deprecated: false,
    });
    expect(merged.get('reports.legacy_pdf')?.deprecated).toBe(true);
  });
  it.each([
    'Reports.export',
    'reports',
    'reports.',
    '1x.y',
    'x.Y',
    'x.y.z',
    `${'a'.repeat(33)}.b`,
    `a.${'b'.repeat(49)}`,
  ])('EC-1: key %j does not match FEATURE_KEY_PATTERN', (key) => {
    expect(
      featureCatalogueProblems([one(key, { kind: 'FLAG', fallback: false })]),
    ).toContain(
      `"${key}": key must match ${FEATURE_KEY_PATTERN.source} (<module>.<name>)`,
    );
  });
  it('EC-2: the same key in two catalogues refuses the merge', () => {
    const a = one('x.flag', { kind: 'FLAG', fallback: false });
    const b = one('x.flag', { kind: 'FLAG', fallback: true });
    expect(featureCatalogueProblems([a, b])).toContain(
      'duplicate feature key "x.flag" in two catalogues',
    );
    expect(() => mergeFeatureCatalogues([a, b])).toThrow(FeatureCatalogueError);
  });
  it.each([
    [
      'FLAG with a numeric fallback',
      { kind: 'FLAG', fallback: { max: 1 } },
      '"x.y": a FLAG fallback must be a boolean',
    ],
    [
      'LIMIT with a boolean fallback',
      { kind: 'LIMIT', fallback: true },
      `"x.y": fallback must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`,
    ],
    [
      'LIMIT with a fractional max',
      { kind: 'LIMIT', fallback: { max: 1.5 } },
      `"x.y": fallback must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`,
    ],
    [
      'LIMIT with an extra field',
      { kind: 'LIMIT', fallback: { max: 1, min: 0 } },
      `"x.y": fallback must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`,
    ],
  ])('EC-3: %s', (_, f, problem) => {
    expect(featureCatalogueProblems([one('x.y', f)])).toContain(problem);
  });
  it('EC-4: QUOTA without (or with an unknown) resetPeriod', () => {
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'QUOTA', fallback: { max: 1 } }),
      ]),
    ).toContain('"x.y": QUOTA needs resetPeriod NONE or MONTH');
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'QUOTA', resetPeriod: 'DAY', fallback: { max: 1 } }),
      ]),
    ).toContain('"x.y": QUOTA needs resetPeriod NONE or MONTH');
  });
  it('EC-5: FLAG or LIMIT declaring resetPeriod; FLAG declaring minimum', () => {
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'FLAG', fallback: true, resetPeriod: 'MONTH' }),
      ]),
    ).toContain('"x.y": only QUOTA declares resetPeriod');
    expect(
      featureCatalogueProblems([
        one('x.y', {
          kind: 'LIMIT',
          fallback: { max: 1 },
          resetPeriod: 'NONE',
        }),
      ]),
    ).toContain('"x.y": only QUOTA declares resetPeriod');
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'FLAG', fallback: true, minimum: 0 }),
      ]),
    ).toContain('"x.y": only LIMIT and QUOTA declare minimum');
  });
  it('EC-6: minimum above the fallback, or a minimum that is not a count', () => {
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'LIMIT', fallback: { max: 0 }, minimum: 1 }),
      ]),
    ).toContain('"x.y": fallback 0 is below minimum 1');
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'LIMIT', fallback: UNLIMITED, minimum: -1 }),
      ]),
    ).toContain(
      `"x.y": minimum must be an integer in [0, ${ENTITLEMENT_VALUE_MAX}]`,
    );
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 }),
      ]),
    ).toEqual([]);
  });
  it('an unknown kind is reported, never silently dropped', () => {
    expect(
      featureCatalogueProblems([
        one('x.y', { kind: 'COUNTER', fallback: 1 }),
      ]).join('\n'),
    ).toMatch(/"x\.y": unknown kind/);
  });
  it('ENTITLEMENT_VALUE_MAX is 2^53 − 1, the CHECK bound of the migrations', () => {
    expect(ENTITLEMENT_VALUE_MAX).toBe(9_007_199_254_740_991);
  });
});
