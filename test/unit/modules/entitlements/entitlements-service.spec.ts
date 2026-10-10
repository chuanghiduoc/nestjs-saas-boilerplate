import {
  Injectable,
  Logger,
  type INestApplicationContext,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import {
  ENTITLEMENT_PLANS,
  EntitlementCatalogueRegistry,
  FeatureCatalogueContributor,
} from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import { UNLIMITED } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  EntitlementsVersionSkewError,
  FeatureKindMismatchError,
  UnknownFeatureError,
} from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import {
  OrgEntitlementRepository,
  type SnapshotOverride,
  type SnapshotRow,
} from '../../../../src/modules/entitlements/ports/org-entitlement.repository.js';

const Features = defineFeatureCatalogue({
  'x.flag': { kind: 'FLAG', fallback: false },
  'x.seats': { kind: 'LIMIT', fallback: { max: 2 }, minimum: 1 },
  'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 100 } },
});
@Injectable()
@FeatureCatalogueContributor(Features)
class Contributor {}
const plans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: {
    free: { values: {} },
    pro: { values: { 'x.flag': true, 'x.seats': UNLIMITED } },
  },
});
const ORG = '0198c000-0000-7000-8000-00000000000a';
const state: { orgId: string | undefined; row: SnapshotRow | undefined } = {
  orgId: ORG,
  row: undefined,
};
const row = (
  planKey: string,
  overrides: readonly SnapshotOverride[] = [],
): SnapshotRow => ({
  version: 1,
  planKey,
  planSource: 'DEFAULT',
  planAssignedAt: new Date(),
  now: new Date(),
  overrides,
});

describe('Entitlements (spec SP4 §6.4, §8.4, §9.5)', () => {
  let ref: INestApplicationContext;
  let svc: Entitlements;
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        Contributor,
        EntitlementCatalogueRegistry,
        EntitlementsMetrics,
        Entitlements,
        { provide: ENTITLEMENT_PLANS, useValue: plans },
        {
          provide: OrgEntitlementRepository,
          useValue: { readSnapshot: () => Promise.resolve(state.row) },
        },
        { provide: RequestContext, useValue: { orgId: () => state.orgId } },
        {
          provide: entitlementsConfig.KEY,
          useValue: { quotaTimezone: 'UTC', rowMissingRetryAfterSec: 7 },
        },
      ],
    }).compile();
    ref = await m.init();
    svc = ref.get(Entitlements);
  });
  const on = (plan: string) => {
    state.orgId = ORG;
    state.row = row(plan);
  };

  it('snapshot resolves every feature of the merged catalogue against the plan', async () => {
    on('pro');
    const s = await svc.snapshot();
    expect(s.plan).toMatchObject({ key: 'pro', source: 'DEFAULT' });
    expect(s.features.get('x.flag')).toEqual({
      kind: 'FLAG',
      enabled: true,
      source: 'PLAN',
    });
    expect(s.features.get('x.seats')).toEqual({
      kind: 'LIMIT',
      limit: { kind: 'UNLIMITED' },
      source: 'PLAN',
    });
    expect(s.features.get('x.calls')).toEqual({
      kind: 'QUOTA',
      limit: { kind: 'MAX', max: 100 },
      resetPeriod: 'MONTH',
      source: 'FALLBACK',
    });
  });
  it('isEnabled / assertEnabled: a disabled FLAG is 403 feature_not_in_plan with the key in errors[0]', async () => {
    on('free');
    expect(await svc.isEnabled('x.flag')).toBe(false);
    const err: unknown = await svc
      .assertEnabled('x.flag')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    if (!(err instanceof AppError)) return;
    expect([err.error.code, err.error.status, err.opts.fields]).toEqual([
      'feature_not_in_plan',
      403,
      [
        {
          path: 'feature',
          code: 'x.flag',
          message: 'Feature is not included in your plan',
        },
      ],
    ]);
    on('pro');
    await expect(svc.assertEnabled('x.flag')).resolves.toBeUndefined();
  });
  it('limitOf and assertWithinLimit: MAX(2) allows 1 + 1, refuses 2 + 1 with 422 quota_exceeded; UNLIMITED allows anything', async () => {
    on('free');
    expect(await svc.limitOf('x.seats')).toEqual({ kind: 'MAX', max: 2 });
    await expect(svc.assertWithinLimit('x.seats', 1)).resolves.toBeUndefined();
    const err: unknown = await svc
      .assertWithinLimit('x.seats', 2)
      .catch((e: unknown) => e);
    expect(
      err instanceof AppError
        ? [err.error.code, err.opts.fields?.[0]?.code]
        : [],
    ).toEqual(['quota_exceeded', 'x.seats']);
    on('pro');
    await expect(
      svc.assertWithinLimit('x.seats', 1_000_000, 5),
    ).resolves.toBeUndefined();
  });
  it('programmer errors are named: unknown key, wrong kind, non-integer counts', async () => {
    on('free');
    await expect(svc.isEnabled('x.ghost')).rejects.toBeInstanceOf(
      UnknownFeatureError,
    );
    await expect(svc.isEnabled('x.seats')).rejects.toBeInstanceOf(
      FeatureKindMismatchError,
    );
    await expect(svc.limitOf('x.flag')).rejects.toBeInstanceOf(
      FeatureKindMismatchError,
    );
    await expect(svc.assertWithinLimit('x.calls', 1)).rejects.toBeInstanceOf(
      FeatureKindMismatchError,
    );
    await expect(svc.assertWithinLimit('x.seats', 1.5)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(svc.assertWithinLimit('x.seats', 1, 0)).rejects.toBeInstanceOf(
      RangeError,
    );
  });
  it('no row → EntitlementsRowMissingError carrying Retry-After from config; unknown plan → EntitlementsVersionSkewError', async () => {
    state.orgId = ORG;
    state.row = undefined;
    const missing: unknown = await svc.snapshot().catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(EntitlementsRowMissingError);
    expect(
      missing instanceof EntitlementsRowMissingError
        ? missing.retryAfterSec
        : 0,
    ).toBe(7);
    state.row = row('gold');
    await expect(svc.snapshot()).rejects.toBeInstanceOf(
      EntitlementsVersionSkewError,
    );
  });
  it('without an org context every call is an EntitlementsContextError, before any read', async () => {
    state.orgId = undefined;
    state.row = row('pro');
    await expect(svc.snapshot()).rejects.toBeInstanceOf(
      EntitlementsContextError,
    );
    await expect(svc.assertEnabled('x.flag')).rejects.toBeInstanceOf(
      EntitlementsContextError,
    );
  });
  it('4C: an active override wins over the plan and is listed in snapshot.overrides; one at its expiry instant is ignored (boundary >)', async () => {
    const now = new Date('2026-10-07T00:00:00.000Z');
    const until = new Date('2026-11-01T00:00:00.000Z');
    state.orgId = ORG;
    state.row = {
      ...row('pro', [
        {
          featureKey: 'x.flag',
          flagValue: false,
          limitValue: null,
          expiresAt: until,
        },
        {
          featureKey: 'x.seats',
          flagValue: null,
          limitValue: 3,
          expiresAt: now,
        },
      ]),
      now,
    };
    const s = await svc.snapshot();
    expect(s.features.get('x.flag')).toEqual({
      kind: 'FLAG',
      enabled: false,
      source: 'OVERRIDE',
    });
    expect(s.features.get('x.seats')).toEqual({
      kind: 'LIMIT',
      limit: { kind: 'UNLIMITED' },
      source: 'PLAN',
    });
    expect([...s.overrides]).toEqual([['x.flag', { expiresAt: until }]]);
  });
  it('Review Focus 3: an override of a feature unknown to this pod is ignored with one warning per key and process', async () => {
    state.orgId = ORG;
    state.row = row('free', [
      {
        featureKey: 'x.ghost',
        flagValue: true,
        limitValue: null,
        expiresAt: null,
      },
    ]);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const s = await svc.snapshot();
      await svc.snapshot();
      expect([s.features.has('x.ghost'), s.overrides.size]).toEqual([false, 0]);
      expect(
        warn.mock.calls.filter(
          ([o]) =>
            Reflect.get(Object(o), 'event') ===
            'entitlements_unknown_override_feature',
        ),
      ).toEqual([
        [
          {
            event: 'entitlements_unknown_override_feature',
            feature: 'x.ghost',
          },
          expect.any(String),
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
