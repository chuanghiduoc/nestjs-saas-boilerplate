import { describe, expect, it } from 'vitest';
import type { EntitlementSnapshot } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import {
  UNLIMITED,
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  OrgEntitlementsResponse,
  orgEntitlementsOf,
} from '../../../../src/modules/entitlements/http/schemas.js';

const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: { max: 3 } },
  }),
]);
const snapshot: EntitlementSnapshot = {
  version: 2,
  plan: {
    key: 'pro',
    source: 'BILLING',
    assignedAt: new Date('2026-10-01T00:00:00.000Z'),
  },
  features: new Map([
    ['x.flag', { kind: 'FLAG', enabled: true, source: 'PLAN' }],
    ['x.old', { kind: 'FLAG', enabled: false, source: 'FALLBACK' }],
    [
      'x.seats',
      { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'FALLBACK' },
    ],
    [
      'x.calls',
      {
        kind: 'QUOTA',
        limit: { kind: 'MAX', max: 3 },
        resetPeriod: 'NONE',
        source: 'FALLBACK',
      },
    ],
  ]),
};

describe('tenant entitlements response (spec SP4 §12.1)', () => {
  it('sorted by key, deprecated hidden, nullable fields present, UNLIMITED as unlimited:true, limit:null (Review Focus 4)', () => {
    const body = OrgEntitlementsResponse.parse(
      orgEntitlementsOf(snapshot, features),
    );
    expect(body).toEqual({
      plan: {
        key: 'pro',
        source: 'BILLING',
        assignedAt: '2026-10-01T00:00:00.000Z',
      },
      features: [
        {
          key: 'x.calls',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          unlimited: false,
          limit: 3,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
        {
          key: 'x.flag',
          kind: 'FLAG',
          enabled: true,
          source: 'PLAN',
          overrideExpiresAt: null,
        },
        {
          key: 'x.seats',
          kind: 'LIMIT',
          unlimited: true,
          limit: null,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/Infinity|Symbol/);
  });
});
