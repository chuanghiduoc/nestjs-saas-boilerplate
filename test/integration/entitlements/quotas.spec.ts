import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RequestContext,
  type Principal,
} from '../../../src/core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import {
  toEnvelope,
  type OutboxRow,
} from '../../../src/core/events/event-dispatch.handlers.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  FeatureKindMismatchError,
  QuotaReachedEvent,
  Quotas,
} from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  periodStartOf,
  readCounters,
  seedCounter,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const OUTBOX_SQL = `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
  aggregate_version::text AS aggregate_version, payload, headers, occurred_at
  FROM outbox_events WHERE type = 'entitlements.quota.reached' AND org_id = $1 ORDER BY id`;

describe('Quotas.consume on Postgres (spec SP4 §9.2, S4-D6, S4-D16; QU-3…QU-6, QU-9)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const quotas = () => app.get(Quotas);
  /** Transaction của caller (feature thật gọi trong `UnitOfWork.run` của side effect, spec §9.2). */
  const inTx = <T>(
    orgId: string,
    fn: () => Promise<T>,
    principal?: Principal,
  ) =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() => {
        if (principal) app.get(RequestContext).setPrincipal(principal);
        return fn();
      }),
    );
  const orgOn = async (plan: string | undefined) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  const reached = (orgId: string) =>
    ownerQuery<OutboxRow>(OUTBOX_SQL, [orgId]).then((rows) =>
      rows.map((r) => parseEnvelope(QuotaReachedEvent, toEnvelope(r))),
    );
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

  it('consumes in the caller transaction; the receipt names the period row; metric and span say consumed', async () => {
    const o = await orgOn('metered');
    const r = await inTx(o.orgId, () =>
      quotas().consume('fixture.api_calls', 2),
    );
    expect(r).toEqual({
      kind: 'CONSUMED',
      receipt: {
        featureKey: 'fixture.api_calls',
        periodStart: (await periodStartOf(0)).toISOString(),
        amount: 2,
      },
    });
    expect(
      (await readCounters(o.orgId)).map((c) => [c.feature, c.used, c.version]),
    ).toEqual([['fixture.api_calls', 2, 1]]);
    expect(
      await otel.metric('entitlements_quota_consume_total', {
        feature: 'fixture.api_calls',
        result: 'consumed',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      otel
        .spans('entitlements.quota.consume')
        .map((s) => s.attributes['entitlements.result']),
    ).toContain('consumed');
  });
  it('QU-4: the caller transaction rolls back → the quota comes back (no row, no event)', async () => {
    const o = await orgOn('metered');
    await expect(
      inTx(o.orgId, async () => {
        await quotas().consume('fixture.api_calls', 3);
        throw new Error('side effect failed');
      }),
    ).rejects.toThrow('side effect failed');
    expect(await readCounters(o.orgId)).toEqual([]);
    expect(await reached(o.orgId)).toEqual([]);
  });
  it('QU-5: UNLIMITED still counts; amount above a MAX limit is EXCEEDED and creates no row', async () => {
    const u = await orgOn('unmetered');
    await inTx(u.orgId, () => quotas().consume('fixture.saved_reports', 1_000));
    expect((await readCounters(u.orgId)).map((c) => c.used)).toEqual([1_000]);
    const m = await orgOn('metered');
    expect(
      await inTx(m.orgId, () => quotas().consume('fixture.saved_reports', 3)),
    ).toEqual({
      kind: 'EXCEEDED',
      limit: 2,
      used: 0,
    });
    expect(await readCounters(m.orgId)).toEqual([]);
    expect(
      await otel.metric('entitlements_quota_consume_total', {
        feature: 'fixture.saved_reports',
        result: 'exceeded',
      }),
    ).toBeGreaterThanOrEqual(1);
  });
  it('consumeOrThrow at the limit → 422 quota_exceeded with errors[0] = { path: feature, code: <key> }; nothing changes', async () => {
    const o = await orgOn('metered');
    await inTx(o.orgId, () =>
      quotas().consumeOrThrow('fixture.saved_reports', 2),
    );
    const err: unknown = await inTx(o.orgId, () =>
      quotas().consumeOrThrow('fixture.saved_reports', 1),
    ).catch((e: unknown) => e);
    expect(
      err instanceof AppError
        ? [
            err.error.code,
            err.opts.fields?.[0]?.path,
            err.opts.fields?.[0]?.code,
          ]
        : [],
    ).toEqual(['quota_exceeded', 'feature', 'fixture.saved_reports']);
    expect((await readCounters(o.orgId)).map((c) => c.used)).toEqual([2]);
  });
  it('QU-6 (sequential): quota.reached once, by the consume that reaches the limit; never for a refused consume', async () => {
    const o = await orgOn('metered');
    const user: Principal = { type: 'user', id: v7() };
    for (let i = 0; i < 3; i++)
      await inTx(o.orgId, () => quotas().consume('fixture.api_calls', 1), user);
    expect(
      (
        await inTx(
          o.orgId,
          () => quotas().consume('fixture.api_calls', 1),
          user,
        )
      ).kind,
    ).toBe('EXCEEDED');
    const events = await reached(o.orgId);
    expect(events).toHaveLength(1);
    expect([
      events[0]?.data,
      events[0]?.aggregate.type,
      events[0]?.aggregate.version,
      events[0]?.actor,
    ]).toEqual([
      {
        orgId: o.orgId,
        feature: 'fixture.api_calls',
        periodStart: (await periodStartOf(0)).toISOString(),
        limit: 3,
        used: 3,
      },
      'usage_counter',
      3,
      user,
    ]);
  });
  it('Review Focus 5: reaching the limit under an org API key principal publishes with a service actor', async () => {
    const o = await orgOn('metered');
    const key: Principal = { type: 'api_key', id: v7() };
    const r = await inTx(
      o.orgId,
      () => quotas().consume('fixture.saved_reports', 2),
      key,
    );
    expect(r.kind).toBe('CONSUMED');
    expect((await reached(o.orgId)).map((e) => e.actor)).toEqual([
      { type: 'service', id: `api_key:${key.id}` },
    ]);
  });
  it('QU-3 (app path): a full previous-month counter does not block this month; the new row is the current period', async () => {
    const o = await orgOn('metered');
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 3,
      period: { monthsAgo: 1 },
    });
    expect(
      (await inTx(o.orgId, () => quotas().consume('fixture.api_calls', 1)))
        .kind,
    ).toBe('CONSUMED');
    expect(
      (await readCounters(o.orgId)).map((c) => [
        c.periodStart?.toISOString(),
        c.used,
      ]),
    ).toEqual([
      [(await periodStartOf(1)).toISOString(), 3],
      [(await periodStartOf(0)).toISOString(), 1],
    ]);
  });
  it('QU-9: outside a UnitOfWork, or without an organization context → EntitlementsContextError', async () => {
    const o = await orgOn('metered');
    await expect(
      app
        .get(OrgScope)
        .run(o.orgId, () => quotas().consume('fixture.api_calls', 1)),
    ).rejects.toBeInstanceOf(EntitlementsContextError);
    await expect(
      app.get(UnitOfWork).run(() => quotas().consume('fixture.api_calls', 1)),
    ).rejects.toBeInstanceOf(EntitlementsContextError);
  });
  it('a LIMIT or a FLAG key → FeatureKindMismatchError (500); an org without its row → EntitlementsRowMissingError (503)', async () => {
    const o = await orgOn('metered');
    for (const k of ['fixture.projects', 'fixture.reports'])
      await expect(
        inTx(o.orgId, () => quotas().consume(k, 1)),
        k,
      ).rejects.toBeInstanceOf(FeatureKindMismatchError);
    const bare = await orgOn(undefined);
    const error = vi.spyOn(Logger.prototype, 'error');
    await expect(
      inTx(bare.orgId, () => quotas().consume('fixture.api_calls', 1)),
    ).rejects.toBeInstanceOf(EntitlementsRowMissingError);
    expect(
      error.mock.calls.some(([m]) =>
        JSON.stringify(m).includes('entitlements_row_missing'),
      ),
    ).toBe(true);
    error.mockRestore();
  });
  it('Review Focus 1: a non-integer or out-of-range amount is refused before any SQL; no row', async () => {
    const o = await orgOn('metered');
    for (const amount of [0, -1, 1.5, Number.NaN, 2 ** 53])
      await expect(
        inTx(o.orgId, () => quotas().consume('fixture.api_calls', amount)),
        String(amount),
      ).rejects.toBeInstanceOf(RangeError);
    expect(await readCounters(o.orgId)).toEqual([]);
  });
});
