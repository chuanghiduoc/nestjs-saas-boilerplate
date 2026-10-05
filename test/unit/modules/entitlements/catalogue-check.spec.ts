import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntitlementCatalogueCheck } from '../../../../src/modules/entitlements/application/catalogue-check.js';
import { EntitlementCatalogueRegistry } from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import {
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';
import {
  EntitlementCatalogueReader,
  type FeatureRow,
  type PlanRow,
} from '../../../../src/modules/entitlements/ports/catalogue.reader.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

const otel = installOtelCapture();
const features = mergeFeatureCatalogues([
  featureCatalogueData({ 'x.flag': { kind: 'FLAG', fallback: false } }),
]);
const plans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: { free: { values: {} } },
});
const db: { features: FeatureRow[]; plans: PlanRow[]; tz: Error | undefined } =
  {
    features: [],
    plans: [],
    tz: undefined,
  };
const pgError = (code: string): Error =>
  Object.assign(new Error('time zone "Mars/Olympus" not recognized'), { code });

describe('EntitlementCatalogueCheck (spec SP4 §8.3, R-X30, M6; unit)', () => {
  let check: EntitlementCatalogueCheck;
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      providers: [
        EntitlementCatalogueCheck,
        EntitlementsMetrics,
        {
          provide: EntitlementCatalogueRegistry,
          useValue: { features: () => features, plans: () => plans },
        },
        {
          provide: EntitlementCatalogueReader,
          useValue: {
            features: () => Promise.resolve(db.features),
            plans: () => Promise.resolve(db.plans),
            probeTimezone: () =>
              db.tz ? Promise.reject(db.tz) : Promise.resolve(),
          },
        },
        {
          provide: entitlementsConfig.KEY,
          useValue: {
            quotaTimezone: 'Asia/Ho_Chi_Minh',
            rowMissingRetryAfterSec: 5,
          },
        },
      ],
    }).compile();
    check = m.get(EntitlementCatalogueCheck);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.tz = undefined;
  });
  const matching = () => {
    db.features = [
      { key: 'x.flag', kind: 'FLAG', resetPeriod: null, deprecated: false },
    ];
    db.plans = [{ key: 'free', retired: false }];
  };

  it('a row only in the database: one WARN per key with its event, the unknown-features counter, no throw, no mismatch count', async () => {
    matching();
    db.features.push({
      key: 'x.ghost',
      kind: 'QUOTA',
      resetPeriod: 'NONE',
      deprecated: false,
    });
    db.plans.push({ key: 'gold', retired: false });
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const mismatch =
      (await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0;
    await expect(check.onModuleInit()).resolves.toBeUndefined();
    expect(warn.mock.calls.map(([m]) => m)).toEqual([
      { event: 'entitlement_feature_unknown_to_code', key: 'x.ghost' },
      { event: 'entitlement_plan_unknown_to_code', key: 'gold' },
    ]);
    expect(
      await otel.metric('entitlements_catalogue_unknown_features_total'),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await otel.metric('entitlements_catalogue_unknown_plans_total'),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0,
    ).toBe(mismatch);
  });
  it('an error still refuses to boot and counts a mismatch', async () => {
    matching();
    db.features = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(check.onModuleInit()).rejects.toThrow(
      /feature x\.flag: in code, missing in the database/,
    );
  });
  it('M6: a timezone Postgres does not know (22023) refuses to boot, naming the env', async () => {
    matching();
    db.tz = pgError('22023');
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await expect(check.onModuleInit()).rejects.toThrow(
      /ENTITLEMENTS_QUOTA_TIMEZONE "Asia\/Ho_Chi_Minh"/,
    );
    expect(error.mock.calls.map(([m]) => m)).toContainEqual(
      expect.objectContaining({ event: 'entitlements_quota_timezone_unknown' }),
    );
  });
  it('M6: any other error of the probe is an infrastructure error and propagates unchanged', async () => {
    matching();
    const infra = pgError('08006');
    db.tz = infra;
    await expect(check.onModuleInit()).rejects.toBe(infra);
  });
});
