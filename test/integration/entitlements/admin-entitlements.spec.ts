import { Logger, type INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import { AdminEntitlements } from '../../../src/modules/entitlements/application/admin-entitlements.service.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  seedCounter,
  seedOrgEntitlement,
  seedOverride,
} from '../../support/entitlements-seed.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const STAFF = '0198c000-0000-7000-8000-00000000c7a2';
const codeOf = (e: unknown) => (e instanceof AppError ? e.error.code : e);

describe('AdminEntitlements (spec SP4 §10.2 PLATFORM_ADMIN, §12.2, S4-D19)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const admin = () => app.get(AdminEntitlements);
  const asStaff = <T>(fn: () => Promise<T>) =>
    app.get(ClsService).run(() => {
      app.get(RequestContext).setPrincipal({ type: 'user', id: STAFF });
      return fn();
    });
  const metric = async (result: string) =>
    (await otel.metric('entitlements_plan_assignments_total', {
      cause: 'PLATFORM_ADMIN',
      result,
    })) ?? 0;
  const orgOn = async (
    plan: string | undefined,
    opts: Parameters<typeof seedOrgEntitlement>[2] = {},
  ) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('view: root, snapshot, usage and every override (expired included) from one REPEATABLE READ snapshot; an org without a root row → 404', async () => {
    const o = await orgOn('metered', {
      source: 'BILLING',
      sourceRef: 'sub_3',
      lastBillingSeq: 2n,
    });
    await seedOverride(o.orgId, 'fixture.projects', {
      value: { limit: 4 },
      expiresInSec: -60,
    });
    await seedOverride(o.orgId, 'tenancy.seats', { value: { limit: 6 } });
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 5,
      period: { monthsAgo: 0 },
    });
    const v = await asStaff(() => admin().view(o.orgId));
    expect([
      v.root.version,
      v.snapshot.version,
      v.root.sourceRef,
      v.root.lastBillingSeq,
    ]).toEqual([1, 1, 'sub_3', 2n]);
    expect(v.overrides.map((x) => x.featureKey)).toEqual([
      'fixture.projects',
      'tenancy.seats',
    ]);
    expect(v.snapshot.features.get('tenancy.seats')).toMatchObject({
      source: 'OVERRIDE',
    });
    expect(v.snapshot.features.get('fixture.projects')).toMatchObject({
      source: 'FALLBACK',
    });
    expect(v.usage.used.get('fixture.api_calls')).toBe(5);
    const bare = await orgOn(undefined);
    expect(await asStaff(() => admin().view(bare.orgId)).catch(codeOf)).toBe(
      'not_found',
    );
  });
  it('assignPlan: APPLIED returns the new view and publishes the reason (R-X31); the same plan and reason again is UNCHANGED; a new reason is APPLIED (M1)', async () => {
    const o = await orgOn('free');
    const v = await asStaff(() =>
      admin().assignPlan(o.orgId, 'W/"1"', { planKey: 'pro', reason: 'pilot' }),
    );
    expect([
      v.root.version,
      v.snapshot.plan.key,
      v.snapshot.plan.source,
      v.root.reason,
    ]).toEqual([2, 'pro', 'PLATFORM_ADMIN', 'pilot']);
    const again = await asStaff(() =>
      admin().assignPlan(o.orgId, 'W/"2"', { planKey: 'pro', reason: 'pilot' }),
    );
    expect(again.root.version).toBe(2);
    // M-2: trạng thái đã có với ETag cũ → no-op 200 (version hiện tại); trạng thái khác với ETag cũ → 412.
    expect(
      (
        await asStaff(() =>
          admin().assignPlan(o.orgId, 'W/"1"', {
            planKey: 'pro',
            reason: 'pilot',
          }),
        )
      ).root.version,
    ).toBe(2);
    expect(
      await asStaff(() =>
        admin().assignPlan(o.orgId, 'W/"1"', {
          planKey: 'pro',
          reason: 'pilot extended',
        }),
      ).catch(codeOf),
    ).toBe('precondition_failed');
    const renamed = await asStaff(() =>
      admin().assignPlan(o.orgId, 'W/"2"', {
        planKey: 'pro',
        reason: 'pilot extended',
      }),
    );
    expect([renamed.root.version, renamed.root.reason]).toEqual([
      3,
      'pilot extended',
    ]);
    expect(
      (await outboxOf(o.orgId, 'entitlements.plan.changed')).map((e) => [
        e.payload.reason,
        e.payload.fromPlan,
        e.payload.toPlan,
        e.headers.actorId,
      ]),
    ).toEqual([
      ['pilot', 'free', 'pro', STAFF],
      ['pilot extended', 'pro', 'pro', STAFF],
    ]);
  });
  it('assignPlan: an unknown plan → 422 unknown_plan before any lock or ERROR log, counted; a retired plan → 422 plan_retired; nothing changes', async () => {
    const o = await orgOn('free');
    const error = vi.spyOn(Logger.prototype, 'error');
    const before = await metric('unknown_plan');
    expect(
      await asStaff(() =>
        admin().assignPlan(o.orgId, 'W/"1"', {
          planKey: 'gold',
          reason: 'typo',
        }),
      ).catch(codeOf),
    ).toBe('unknown_plan');
    expect(await metric('unknown_plan')).toBe(before + 1);
    expect(
      error.mock.calls.filter(
        ([x]) =>
          Reflect.get(Object(x), 'event') === 'entitlements_unknown_plan',
      ),
    ).toEqual([]);
    error.mockRestore();
    expect(
      await asStaff(() =>
        admin().assignPlan(o.orgId, 'W/"1"', {
          planKey: 'legacy',
          reason: 'old',
        }),
      ).catch(codeOf),
    ).toBe('plan_retired');
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'free',
      source: 'DEFAULT',
      version: 1,
    });
  });
  it('assignPlan: a stale If-Match → 412 counted as precondition_failed; * and a missing If-Match → 428 (Spec-I1), nothing written', async () => {
    const o = await orgOn('free');
    const before = await metric('precondition_failed');
    expect(
      await asStaff(() =>
        admin().assignPlan(o.orgId, 'W/"5"', { planKey: 'pro', reason: 'x' }),
      ).catch(codeOf),
    ).toBe('precondition_failed');
    expect(await metric('precondition_failed')).toBe(before + 1);
    for (const ifMatch of ['*', undefined])
      expect(
        await asStaff(() =>
          admin().assignPlan(o.orgId, ifMatch, { planKey: 'pro', reason: 'x' }),
        ).catch(codeOf),
      ).toBe('precondition_required');
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
  });
  it('setOverride returns the view with the active override; removeOverride returns the new version', async () => {
    const o = await orgOn('pro');
    const v = await asStaff(() =>
      admin().setOverride(o.orgId, 'tenancy.seats', 'W/"1"', {
        value: { limit: 2 },
        reason: 'promo',
        expiresAt: null,
      }),
    );
    expect([
      v.root.version,
      v.overrides.map((x) => [x.featureKey, x.limitValue]),
    ]).toEqual([2, [['tenancy.seats', 2]]]);
    expect(v.snapshot.features.get('tenancy.seats')).toEqual({
      kind: 'LIMIT',
      limit: { kind: 'MAX', max: 2 },
      source: 'OVERRIDE',
    });
    expect(
      await asStaff(() =>
        admin().removeOverride(o.orgId, 'tenancy.seats', 'promo over', 'W/"2"'),
      ),
    ).toBe(3);
  });
});
