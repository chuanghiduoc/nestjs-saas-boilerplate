import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { EntitlementCatalogueCheck } from '../../../src/modules/entitlements/application/catalogue-check.js';
import { UnknownFeatureError } from '../../../src/modules/entitlements/index.js';
import { monthPeriodStartSql } from '../../../src/modules/entitlements/infra/sql/sql-usage-counter.repository.js';
import { UsageCounterRepository } from '../../../src/modules/entitlements/ports/usage-counter.repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  QUOTA_TZ,
  periodStartOf,
  readCounters,
  seedCounter,
  seedOrgEntitlement,
  withOwner,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const MONTH = { kind: 'MONTH', timezone: QUOTA_TZ } as const;
const NONE = { kind: 'NONE' } as const;
const iso = (v: unknown) => z.coerce.date().parse(v).toISOString();

describe('SqlUsageCounterRepository (spec SP4 §9.2, §9.3, §12.1; S4-T2, QU-3)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const repo = () => app.get(UsageCounterRepository);
  const id = (key: string) => app.get(EntitlementCatalogueCheck).featureId(key);
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  const freshOrg = async () => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, 'metered');
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

  it('featureId is the id of the entitlement_features row read by the boot-time check; an unknown key is UnknownFeatureError', async () => {
    const rows = await withOwner(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT id::text AS id FROM entitlement_features WHERE key = 'fixture.api_calls'`,
          )
        ).rows,
    );
    expect(id('fixture.api_calls')).toBe(rows[0]?.id);
    expect(() => id('fixture.nope')).toThrow(UnknownFeatureError);
  });
  it('S4-T2 through Db.execute placeholders: NULL period 3 → 5 → refused; one row, version 2', async () => {
    const o = await freshOrg();
    const f = id('fixture.saved_reports');
    const r1 = await inTx(o.orgId, () =>
      repo().consume({ featureId: f, period: NONE, amount: 3, max: 5 }),
    );
    const r2 = await inTx(o.orgId, () =>
      repo().consume({ featureId: f, period: NONE, amount: 2, max: 5 }),
    );
    const r3 = await inTx(o.orgId, () =>
      repo().consume({ featureId: f, period: NONE, amount: 1, max: 5 }),
    );
    expect([
      r1?.used,
      r1?.version,
      r1?.periodStart,
      r2?.used,
      r2?.version,
      r3,
    ]).toEqual([3, 1, null, 5, 2, undefined]);
    expect(r2?.id).toBe(r1?.id);
    expect(
      (await readCounters(o.orgId)).map((r) => [r.feature, r.used]),
    ).toEqual([['fixture.saved_reports', 5]]);
  });
  it('max: null (UNLIMITED) has no guard: the counter still counts', async () => {
    const o = await freshOrg();
    const r = await inTx(o.orgId, () =>
      repo().consume({
        featureId: id('fixture.api_calls'),
        period: MONTH,
        amount: 1_000_000,
        max: null,
      }),
    );
    expect(r?.used).toBe(1_000_000);
  });
  it('QU-3: a MONTH consume lands on the month start of the configured timezone, whatever the session TimeZone', async () => {
    const o = await freshOrg();
    const r = await inTx(o.orgId, async () => {
      await app.get(Db).execute(`SET LOCAL TIME ZONE 'America/New_York'`);
      return repo().consume({
        featureId: id('fixture.api_calls'),
        period: MONTH,
        amount: 1,
        max: 3,
      });
    });
    expect(r?.periodStart?.toISOString()).toBe(
      (await periodStartOf(0)).toISOString(),
    );
  });
  it('QU-3 boundary: 16:59:59Z and 17:00:00Z of the last day of September fall in two months in UTC+7', async () => {
    const [row] = await app
      .get(Db)
      .execute<{ a: unknown; b: unknown }>(
        `SELECT ${monthPeriodStartSql('?::timestamptz')} AS a, ${monthPeriodStartSql('?::timestamptz')} AS b`,
        ['2026-09-30T16:59:59Z', QUOTA_TZ, '2026-09-30T17:00:00Z', QUOTA_TZ],
      );
    expect([iso(row?.a), iso(row?.b)]).toEqual([
      '2026-08-31T17:00:00.000Z',
      '2026-09-30T17:00:00.000Z',
    ]);
  });
  it('QU-3: a full counter of the previous month does not block the current month (lazy reset, two rows)', async () => {
    const o = await freshOrg();
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 3,
      period: { monthsAgo: 1 },
    });
    const r = await inTx(o.orgId, () =>
      repo().consume({
        featureId: id('fixture.api_calls'),
        period: MONTH,
        amount: 1,
        max: 3,
      }),
    );
    expect(r?.used).toBe(1);
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
  it('usedNow: 0 without a row; the value of the current period otherwise (read only)', async () => {
    const o = await freshOrg();
    const f = id('fixture.api_calls');
    expect(
      await inTx(o.orgId, () =>
        repo().usedNow({ featureId: f, period: MONTH }),
      ),
    ).toBe(0);
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 2,
      period: { monthsAgo: 0 },
    });
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 9,
      period: { monthsAgo: 1 },
    });
    expect(
      await inTx(o.orgId, () =>
        repo().usedNow({ featureId: f, period: MONTH }),
      ),
    ).toBe(2);
  });
  it('release: the right period decrements and bumps the version; more than used, a missing row or another period → undefined, nothing changes', async () => {
    const o = await freshOrg();
    const f = id('fixture.api_calls');
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 3,
      period: { monthsAgo: 0 },
    });
    const current = (await periodStartOf(0)).toISOString();
    const previous = (await periodStartOf(1)).toISOString();
    expect(
      await inTx(o.orgId, () =>
        repo().release({ featureId: f, periodStart: current, amount: 2 }),
      ),
    ).toBe(1);
    expect(
      await inTx(o.orgId, () =>
        repo().release({ featureId: f, periodStart: current, amount: 2 }),
      ),
    ).toBeUndefined();
    expect(
      await inTx(o.orgId, () =>
        repo().release({ featureId: f, periodStart: previous, amount: 1 }),
      ),
    ).toBeUndefined();
    expect(
      await inTx(o.orgId, () =>
        repo().release({
          featureId: id('fixture.saved_reports'),
          periodStart: null,
          amount: 1,
        }),
      ),
    ).toBeUndefined();
    expect(
      (await readCounters(o.orgId)).map((c) => [c.used, c.version]),
    ).toEqual([[1, 2]]);
  });
  it('currentUsage: month bounds in the timezone; used by key for current MONTH and NONE counters only', async () => {
    const o = await freshOrg();
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 9,
      period: { monthsAgo: 1 },
    });
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 2,
      period: { monthsAgo: 0 },
    });
    await seedCounter(o.orgId, 'fixture.saved_reports', {
      used: 1,
      period: 'NONE',
    });
    const u = await inTx(o.orgId, () => repo().currentUsage(QUOTA_TZ));
    expect(u.periodStart.toISOString()).toBe(
      (await periodStartOf(0)).toISOString(),
    );
    expect(u.periodEnd.toISOString()).toBe(
      (await periodStartOf(-1)).toISOString(),
    );
    expect(Object.fromEntries(u.used)).toEqual({
      'fixture.api_calls': 2,
      'fixture.saved_reports': 1,
    });
  });
  it('currentUsage of an org without counters: the bounds and an empty map', async () => {
    const o = await freshOrg();
    const u = await inTx(o.orgId, () => repo().currentUsage(QUOTA_TZ));
    expect([u.used.size, u.periodEnd > u.periodStart]).toEqual([0, true]);
  });
});
