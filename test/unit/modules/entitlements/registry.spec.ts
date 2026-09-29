import { Injectable, Logger, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENTITLEMENT_PLANS,
  EntitlementCatalogueRegistry,
  FeatureCatalogueContributor,
} from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import {
  FeatureCatalogueError,
  UNLIMITED,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  PlanCatalogueError,
  definePlanCatalogue,
  type PlanCatalogue,
} from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { UnknownFeatureError } from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';

const A = defineFeatureCatalogue({
  'a.flag': { kind: 'FLAG', fallback: false },
});
const B = defineFeatureCatalogue({
  'b.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 },
});
const B2 = defineFeatureCatalogue({
  'b.seats': { kind: 'FLAG', fallback: true },
});
@Injectable()
@FeatureCatalogueContributor(A)
class ContribA {}
@Injectable()
@FeatureCatalogueContributor(B)
class ContribB {}
@Injectable()
@FeatureCatalogueContributor(B2)
class ContribB2 {}
@Injectable()
@FeatureCatalogueContributor(A)
class ContribAAgain {}
@Module({ providers: [ContribA] })
class ModA {}
@Module({ providers: [ContribB] })
class ModB {}
@Module({ providers: [ContribB2] })
class ModB2 {}
const plans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: { free: { values: {} }, pro: { values: { 'a.flag': true } } },
});

const boot = async (
  imports: Parameters<typeof Test.createTestingModule>[0]['imports'],
  p: PlanCatalogue = plans,
) => {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule, ...(imports ?? [])],
    providers: [
      EntitlementCatalogueRegistry,
      { provide: ENTITLEMENT_PLANS, useValue: p },
    ],
  }).compile();
  await ref.init();
  return ref;
};

describe('EntitlementCatalogueRegistry (spec SP4 §8.1–8.2, S4-D1)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('merges the catalogues of two modules, knows their identity, and logs the fallback report once', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const ref = await boot([ModA, ModB]);
    const reg = ref.get(EntitlementCatalogueRegistry);
    expect([...reg.features().keys()].sort()).toEqual(['a.flag', 'b.seats']);
    expect([reg.has(A), reg.has(B), reg.has(B2)]).toEqual([true, true, false]);
    expect(reg.plans()).toBe(plans);
    expect(log).toHaveBeenCalledWith(
      {
        event: 'entitlements_plan_fallbacks',
        fallbacks: { free: ['a.flag', 'b.seats'], pro: ['b.seats'] },
      },
      expect.any(String),
    );
    await ref.close();
  });
  it('the same key in two modules refuses to boot', async () => {
    await expect(boot([ModB, ModB2])).rejects.toBeInstanceOf(
      FeatureCatalogueError,
    );
  });
  it('the same catalogue contributed by two providers refuses to boot (no silent dedupe, as 3A)', async () => {
    await expect(
      boot([ModA, { module: class AAgain {}, providers: [ContribAAgain] }]),
    ).rejects.toThrow(
      /Feature catalogue \[a\.flag\] is contributed twice \(ContribA, ContribAAgain\)/,
    );
  });
  it('the merged catalogue is built on first use, independent of provider init order', async () => {
    const ref = await Test.createTestingModule({
      imports: [DiscoveryModule, ModA],
      providers: [
        EntitlementCatalogueRegistry,
        { provide: ENTITLEMENT_PLANS, useValue: plans },
      ],
    }).compile();
    const reg = ref.get(EntitlementCatalogueRegistry);
    expect([...reg.features().keys()]).toEqual(['a.flag']);
    expect(reg.has(A)).toBe(true);
    await ref.close();
  });
  it('an invalid plan catalogue refuses to boot, listing every problem', async () => {
    const bad = definePlanCatalogue({
      defaultPlan: 'gold',
      plans: { free: { values: { 'a.flag': { max: 1 }, 'x.nope': true } } },
    });
    const err: unknown = await boot([ModA, ModB], bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanCatalogueError);
    expect(
      err instanceof PlanCatalogueError ? [...err.problems].sort() : [],
    ).toEqual([
      'defaultPlan "gold" is not a declared plan',
      'plan "free": "a.flag" is a FLAG and needs true or false',
      'plan "free": unknown feature "x.nope"',
    ]);
  });
  it('feature(key) of an unknown key throws UnknownFeatureError', async () => {
    const ref = await boot([ModA]);
    expect(() =>
      ref.get(EntitlementCatalogueRegistry).feature('z.nope'),
    ).toThrow(UnknownFeatureError);
    await ref.close();
  });
});
