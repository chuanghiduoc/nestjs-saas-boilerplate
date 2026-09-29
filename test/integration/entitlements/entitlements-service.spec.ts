import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError, toAppError } from '../../../src/core/errors/index.js';
import {
  Entitlements,
  EntitlementsRowMissingError,
  EntitlementsVersionSkewError,
} from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  seedOrgEntitlement,
  seedPlans,
} from '../../support/entitlements-seed.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();

describe('Entitlements on the real database (spec SP4 §8.4, criterion 1, F-2, F-6)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const svc = () => app.get(Entitlements);
  const inOrg = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, fn);
  const orgOn = async (plan: string | undefined) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('a pro org resolves plan values, fallbacks and the boilerplate LIMIT under RLS, in and out of a transaction', async () => {
    const o = await orgOn('pro');
    const s = await inOrg(o.orgId, () => svc().snapshot());
    expect(s.plan).toMatchObject({ key: 'pro', source: 'DEFAULT' });
    expect(Object.fromEntries(s.features)).toEqual({
      'fixture.reports': { kind: 'FLAG', enabled: true, source: 'PLAN' },
      'fixture.exports': { kind: 'FLAG', enabled: false, source: 'PLAN' },
      'fixture.projects': {
        kind: 'LIMIT',
        limit: { kind: 'UNLIMITED' },
        source: 'PLAN',
      },
      'fixture.api_calls': {
        kind: 'QUOTA',
        limit: { kind: 'MAX', max: 100 },
        resetPeriod: 'MONTH',
        source: 'FALLBACK',
      },
      'fixture.legacy_pdf': {
        kind: 'FLAG',
        enabled: false,
        source: 'FALLBACK',
      },
      'tenancy.seats': {
        kind: 'LIMIT',
        limit: { kind: 'MAX', max: 10 },
        source: 'PLAN',
      },
    });
    expect(
      await inOrg(o.orgId, () =>
        app.get(UnitOfWork).run(() => svc().isEnabled('fixture.reports')),
      ),
    ).toBe(true);
  });
  it('a free org: a disabled FLAG is 403 feature_not_in_plan (metric labelled by feature); a full LIMIT is 422 quota_exceeded', async () => {
    const o = await orgOn('free');
    const denied: unknown = await inOrg(o.orgId, () =>
      svc().assertEnabled('fixture.reports'),
    ).catch((e: unknown) => e);
    expect(
      denied instanceof AppError
        ? [denied.error.code, denied.opts.fields?.[0]?.code]
        : [],
    ).toEqual(['feature_not_in_plan', 'fixture.reports']);
    expect(
      await otel.metric('entitlements_feature_denied_total', {
        feature: 'fixture.reports',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      otel
        .spans('entitlements.feature.check')
        .map((s) => s.attributes['entitlements.result']),
    ).toContain('denied');
    await expect(
      inOrg(o.orgId, () => svc().assertWithinLimit('fixture.projects', 1)),
    ).resolves.toBeUndefined();
    const full: unknown = await inOrg(o.orgId, () =>
      svc().assertWithinLimit('fixture.projects', 2),
    ).catch((e: unknown) => e);
    expect(full instanceof AppError ? full.error.code : undefined).toBe(
      'quota_exceeded',
    );
  });
  it('criterion 1 / F-2: an org without a row → 503 + Retry-After, ERROR log, entitlements_row_missing_total; never a default plan', async () => {
    const o = await orgOn(undefined);
    const error = vi.spyOn(Logger.prototype, 'error');
    const before = (await otel.metric('entitlements_row_missing_total')) ?? 0;
    const err: unknown = await inOrg(o.orgId, () => svc().snapshot()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EntitlementsRowMissingError);
    const mapped = toAppError(err);
    expect([mapped.error.status, mapped.opts.headers?.['Retry-After']]).toEqual(
      [503, '5'],
    );
    expect(error).toHaveBeenCalledWith(
      { event: 'entitlements_row_missing' },
      expect.any(String),
    );
    expect(await otel.metric('entitlements_row_missing_total')).toBe(
      before + 1,
    );
    error.mockRestore();
  });
  it('F-6: an org on a plan this pod does not know → EntitlementsVersionSkewError (503), not a guess', async () => {
    const disposeGhost = await seedPlans([{ key: 'ghost_plan' }]);
    const o = await orgOn('ghost_plan');
    try {
      const err: unknown = await inOrg(o.orgId, () => svc().snapshot()).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EntitlementsVersionSkewError);
      expect(toAppError(err).error.status).toBe(503);
    } finally {
      await o.dispose();
      orgs.splice(orgs.indexOf(o), 1);
      await disposeGhost();
    }
  });
});
