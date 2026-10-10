import { describe, expect, it } from 'vitest';
import type { AdminView } from '../../../../src/modules/entitlements/application/admin-entitlements.query.js';
import {
  UNLIMITED,
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import {
  AdminOrgEntitlementsResponse,
  AdminPlansResponse,
  DeleteOverrideBody,
  PutOverrideBody,
  PutPlanBody,
  adminEntitlementsOf,
  adminPlansOf,
} from '../../../../src/modules/entitlements/http/schemas.js';

const ORG = '0198c000-0000-7000-8000-00000000000c';
const NOW = new Date('2026-10-07T00:00:00.000Z');
const START = new Date('2026-09-30T17:00:00.000Z');
const END = new Date('2026-10-31T17:00:00.000Z');
const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 3 } },
  }),
]);
const view: AdminView = {
  snapshot: {
    version: 4,
    plan: { key: 'pro', source: 'PLATFORM_ADMIN', assignedAt: NOW },
    features: new Map([
      ['x.flag', { kind: 'FLAG', enabled: true, source: 'PLAN' }],
      ['x.old', { kind: 'FLAG', enabled: false, source: 'FALLBACK' }],
      [
        'x.seats',
        { kind: 'LIMIT', limit: { kind: 'MAX', max: 2 }, source: 'OVERRIDE' },
      ],
      [
        'x.calls',
        {
          kind: 'QUOTA',
          limit: { kind: 'MAX', max: 3 },
          resetPeriod: 'MONTH',
          source: 'FALLBACK',
        },
      ],
    ]),
    overrides: new Map([
      ['x.seats', { expiresAt: new Date('2026-12-01T00:00:00.000Z') }],
    ]),
  },
  usage: {
    periodStart: START,
    periodEnd: END,
    used: new Map([['x.calls', 5]]),
  },
  root: {
    version: 4,
    sourceRef: null,
    reason: 'pilot',
    lastBillingSeq: 12n,
    now: NOW,
  },
  overrides: [
    {
      featureKey: 'x.flag',
      flagValue: false,
      limitValue: null,
      reason: 'old promo',
      expiresAt: NOW,
      updatedAt: NOW,
    },
    {
      featureKey: 'x.seats',
      flagValue: null,
      limitValue: 2,
      reason: 'promo',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      updatedAt: NOW,
    },
  ],
};

describe('admin schemas (spec SP4 §12.2, review 4C)', () => {
  it('the admin view: internal fields, BIGINT as a decimal string, usage like the tenant view (OVER_LIMIT visible), deprecated hidden, override status from the DB clock (EXPIRED at expires_at)', () => {
    const body = AdminOrgEntitlementsResponse.parse(
      adminEntitlementsOf(ORG, view, features),
    );
    expect(body).toMatchObject({
      orgId: ORG,
      version: 4,
      plan: {
        key: 'pro',
        source: 'PLATFORM_ADMIN',
        sourceRef: null,
        reason: 'pilot',
        assignedAt: NOW.toISOString(),
      },
      lastBillingSeq: '12',
    });
    expect(body.features.map((f) => f.key)).toEqual([
      'x.calls',
      'x.flag',
      'x.seats',
    ]);
    expect(body.features.find((f) => f.key === 'x.calls')).toEqual({
      key: 'x.calls',
      kind: 'QUOTA',
      resetPeriod: 'MONTH',
      unlimited: false,
      limit: 3,
      used: 5,
      state: 'OVER_LIMIT',
      periodStart: START.toISOString(),
      periodEnd: END.toISOString(),
      source: 'FALLBACK',
      overrideExpiresAt: null,
    });
    expect(body.features.find((f) => f.key === 'x.seats')).toMatchObject({
      source: 'OVERRIDE',
      overrideExpiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(body.overrides).toEqual([
      {
        kind: 'FLAG',
        enabled: false,
        feature: 'x.flag',
        reason: 'old promo',
        expiresAt: NOW.toISOString(),
        status: 'EXPIRED',
        updatedAt: NOW.toISOString(),
      },
      {
        kind: 'LIMIT',
        unlimited: false,
        limit: 2,
        feature: 'x.seats',
        reason: 'promo',
        expiresAt: '2026-12-01T00:00:00.000Z',
        status: 'ACTIVE',
        updatedAt: NOW.toISOString(),
      },
    ]);
  });
  it('the plan catalogue: sorted plans, default flag, each active feature with PLAN or FALLBACK and no usage', () => {
    const plans = definePlanCatalogue({
      defaultPlan: 'free',
      plans: {
        pro: { values: { 'x.flag': true } },
        free: { values: {} },
        old: { retired: true, values: {} },
      },
    });
    const body = AdminPlansResponse.parse(adminPlansOf(plans, features));
    expect(body.plans.map((p) => [p.key, p.default, p.retired])).toEqual([
      ['free', true, false],
      ['old', false, true],
      ['pro', false, false],
    ]);
    expect(body.plans[2]?.features.map((f) => [f.key, f.source])).toEqual([
      ['x.calls', 'FALLBACK'],
      ['x.flag', 'PLAN'],
      ['x.seats', 'FALLBACK'],
    ]);
    expect(body.plans[2]?.features.some((f) => 'used' in f)).toBe(false);
  });
  it('request bodies: plan needs planKey and a reason; an override takes enabled XOR limit, an ISO UTC expiry or null; DELETE needs a reason', () => {
    expect(
      PutPlanBody.safeParse({ planKey: 'pro', reason: '  pilot ' }).data,
    ).toEqual({ planKey: 'pro', reason: 'pilot' });
    expect(
      PutPlanBody.safeParse({ planKey: 'pro', reason: '   ' }).success,
    ).toBe(false);
    expect(
      PutPlanBody.safeParse({ planKey: 'pro', reason: 'x', extra: 1 }).success,
    ).toBe(false);
    const ok = { reason: 'r', expiresAt: null };
    expect(PutOverrideBody.safeParse({ enabled: true, ...ok }).success).toBe(
      true,
    );
    expect(PutOverrideBody.safeParse({ limit: null, ...ok }).success).toBe(
      true,
    );
    expect(
      PutOverrideBody.safeParse({ enabled: true, limit: 1, ...ok }).success,
    ).toBe(false);
    expect(PutOverrideBody.safeParse({ limit: 2 ** 53, ...ok }).success).toBe(
      false,
    );
    expect(PutOverrideBody.safeParse({ limit: 1, reason: 'r' }).success).toBe(
      false,
    );
    expect(
      PutOverrideBody.safeParse({
        limit: 1,
        reason: 'r',
        expiresAt: '2026-10-07T10:00:00+07:00',
      }).success,
    ).toBe(false);
    // Phán quyết controller (batch 3): `expiresAt` chỉ tới mili giây; nhiều chữ số hơn → 422 trên `expiresAt`.
    for (const at of [
      '2026-10-07T10:00:00Z',
      '2026-10-07T10:00:00.1Z',
      '2026-10-07T10:00:00.123Z',
    ])
      expect(
        PutOverrideBody.safeParse({ limit: 1, reason: 'r', expiresAt: at })
          .success,
        at,
      ).toBe(true);
    const micro = PutOverrideBody.safeParse({
      limit: 1,
      reason: 'r',
      expiresAt: '2026-10-07T10:00:00.1234Z',
    });
    expect(micro.error?.issues.map((i) => i.path)).toEqual([['expiresAt']]);
    expect(DeleteOverrideBody.safeParse({ reason: ' cleanup ' }).data).toEqual({
      reason: 'cleanup',
    });
    expect(DeleteOverrideBody.safeParse({}).success).toBe(false);
  });
});
