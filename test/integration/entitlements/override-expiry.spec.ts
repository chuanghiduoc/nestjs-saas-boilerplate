import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { Quotas } from '../../../src/modules/entitlements/index.js';
import { MemberSeatLimit } from '../../../src/modules/tenancy/index.js';
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
  readOverrides,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** `version` của dòng gốc vừa seed: hết hạn không bao giờ tăng nó. */
const SEEDED_VERSION = 1;
/** Đủ để đồng hồ DB chắc chắn qua `expires_at` trước khi transaction sau bắt đầu (E-12). */
const EXPIRES_AFTER = `interval '50 milliseconds'`;
const SLEEP_SEC = 0.1;
type Expiry = 'at-now' | 'just-after-now';
const EXPIRY_SQL: Record<Expiry, string> = {
  'at-now': 'now()',
  'just-after-now': `now() + interval '1 microsecond'`,
};

describe('override expiry is derived at read time on the 4B paths (spec SP4 §7.4, §8.4, E-12; carried from 4B)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  /** Chèn TRONG transaction của câu đọc: `now()` ở đây là `now()` mà snapshot dùng (mốc chung, tất định). */
  const overrideIn = (key: string, limit: number | null, expiry: Expiry) =>
    app.get(Db).execute(
      `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason, expires_at, updated_at)
       SELECT app_current_org(), id, ?::bigint, 'expiry', ${EXPIRY_SQL[expiry]}, now() - interval '1 second'
       FROM entitlement_features WHERE key = ?`,
      [limit === null ? null : String(limit), key],
    );
  const orgOn = async (plan: string) => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, plan);
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

  it('Review Focus 1 (quota): an override that expires exactly at the transaction now() no longer applies to consume; 1 µs later it does', async () => {
    const atNow = await orgOn('metered');
    expect(
      await inTx(atNow.orgId, async () => {
        await overrideIn('fixture.api_calls', 1, 'at-now');
        return app.get(Quotas).consume('fixture.api_calls', 2);
      }),
    ).toMatchObject({ kind: 'CONSUMED' });
    const later = await orgOn('metered');
    expect(
      await inTx(later.orgId, async () => {
        await overrideIn('fixture.api_calls', 1, 'just-after-now');
        return app.get(Quotas).consume('fixture.api_calls', 2);
      }),
    ).toEqual({ kind: 'EXCEEDED', limit: 1, used: 0 });
  });
  it('Review Focus 1 (seats): the seat port reads the plan at expires_at = now() and the override 1 µs before; NULL is unlimited', async () => {
    const cases: [Expiry, number | null, unknown][] = [
      ['at-now', 1, { kind: 'MAX', max: 3, featureKey: 'tenancy.seats' }],
      [
        'just-after-now',
        1,
        { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' },
      ],
      ['just-after-now', null, { kind: 'UNLIMITED' }],
    ];
    for (const [expiry, limit, expected] of cases) {
      const o = await orgOn('metered');
      expect(
        await inTx(o.orgId, async () => {
          await overrideIn('tenancy.seats', limit, expiry);
          return app.get(MemberSeatLimit).current();
        }),
        `${expiry} ${String(limit)}`,
      ).toEqual(expected);
    }
  });
  it('E-12: the expiry state is fixed for a whole transaction and moves for the next one without any write, event or version change', async () => {
    const o = await orgOn('metered');
    await inTx(o.orgId, async () => {
      await app.get(Db).execute(
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason, expires_at, updated_at)
         SELECT app_current_org(), id, 1, 'e-12', now() + ${EXPIRES_AFTER}, now() - interval '1 second'
         FROM entitlement_features WHERE key = 'tenancy.seats'`,
      );
      const seats = () => app.get(MemberSeatLimit).current();
      expect(await seats()).toEqual({
        kind: 'MAX',
        max: 1,
        featureKey: 'tenancy.seats',
      });
      await app.get(Db).execute(`SELECT pg_sleep(?)`, [SLEEP_SEC]);
      expect(await seats()).toEqual({
        kind: 'MAX',
        max: 1,
        featureKey: 'tenancy.seats',
      });
    });
    // Transaction sau bắt đầu sau khi transaction trên (đã ngủ 100 ms) commit, nên now() của nó > expires_at.
    expect(
      await inTx(o.orgId, () => app.get(MemberSeatLimit).current()),
    ).toEqual({
      kind: 'MAX',
      max: 3,
      featureKey: 'tenancy.seats',
    });
    expect((await readOverrides(o.orgId)).map((r) => r.feature)).toEqual([
      'tenancy.seats',
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(SEEDED_VERSION);
    expect([
      ...(await outboxOf(o.orgId, 'entitlements.override.set')),
      ...(await outboxOf(o.orgId, 'entitlements.override.removed')),
    ]).toEqual([]);
  });
});
