import { Module, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  Db,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import { SqlOrgEntitlementRepository } from '../../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { createTestApp } from '../../support/app-factory.js';
import {
  seedFeatures,
  seedOrgEntitlement,
  seedOverride,
  seedPlans,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

@Module({ providers: [SqlOrgEntitlementRepository] })
class RepoModule {}

describe('SqlOrgEntitlementRepository.readSnapshot (spec SP4 §8.4)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  let disposePlans: () => Promise<void>;
  let disposeFeatures: () => Promise<void>;
  const read = (orgId: string) =>
    app
      .get(OrgScope)
      .run(orgId, () => app.get(SqlOrgEntitlementRepository).readSnapshot());
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RepoModule,
    ]);
    disposeFeatures = await seedFeatures([
      { key: 'snap.a', kind: 'FLAG', resetPeriod: null, deprecated: false },
      { key: 'snap.b', kind: 'LIMIT', resetPeriod: null, deprecated: false },
      { key: 'snap.c', kind: 'LIMIT', resetPeriod: null, deprecated: false },
    ]);
    disposePlans = await seedPlans([{ key: 'snap_pro' }]);
    a = await seedOrg();
    b = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'snap_pro', {
      source: 'BILLING',
      sourceRef: 'sub_9',
      lastBillingSeq: 3n,
    });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await disposeFeatures?.();
    await disposePlans?.();
    await app?.close();
  });

  it('reads the row of the org in scope with parsed types and the database clock', async () => {
    const s = await read(a.orgId);
    expect(s).toMatchObject({
      version: 1,
      planKey: 'snap_pro',
      planSource: 'BILLING',
    });
    expect(s?.planAssignedAt).toBeInstanceOf(Date);
    expect(s?.now).toBeInstanceOf(Date);
    expect(s?.overrides).toEqual([]);
  });
  it('an org without a row reads undefined, never the row of another org (RLS)', async () => {
    expect(await read(b.orgId)).toBeUndefined();
  });
  it('without an org context the read fails closed (P0001)', async () => {
    await expect(
      app
        .get(UnitOfWork)
        .run(() => app.get(SqlOrgEntitlementRepository).readSnapshot()),
    ).rejects.toThrow(/org context is not set/);
  });
  it('4C: reads only the active overrides of the org, sorted by feature key, as parsed types (one row per override)', async () => {
    await seedOverride(a.orgId, 'snap.b', {
      value: { limit: 2 },
      expiresInSec: 3600,
    });
    await seedOverride(a.orgId, 'snap.a', { value: { enabled: true } });
    await seedOverride(a.orgId, 'snap.c', {
      value: { limit: 1 },
      expiresInSec: -60,
    });
    const s = await read(a.orgId);
    expect(
      s?.overrides.map((o) => [
        o.featureKey,
        o.flagValue,
        o.limitValue,
        o.expiresAt instanceof Date,
      ]),
    ).toEqual([
      ['snap.a', true, null, false],
      ['snap.b', null, 2, true],
    ]);
    expect(s?.version).toBe(1);
    expect(await read(b.orgId)).toBeUndefined();
  });
  it('4C boundary (SQL): in one transaction an override expiring exactly at now() is gone and one at now() + 1 µs is active', async () => {
    const s = await app.get(OrgScope).run(a.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        const db = app.get(Db);
        await db.execute(
          `DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org()`,
        );
        await db.execute(
          `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason, expires_at, updated_at)
           SELECT app_current_org(), f.id, 1, 'boundary',
                  CASE f.key WHEN 'snap.b' THEN now() ELSE now() + interval '1 microsecond' END,
                  now() - interval '1 second'
           FROM entitlement_features f WHERE f.key IN ('snap.b', 'snap.c')`,
        );
        return app.get(SqlOrgEntitlementRepository).readSnapshot();
      }),
    );
    expect(s?.overrides.map((o) => o.featureKey)).toEqual(['snap.c']);
  });
});
