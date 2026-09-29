import { Module, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import { SqlOrgEntitlementRepository } from '../../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { createTestApp } from '../../support/app-factory.js';
import {
  seedOrgEntitlement,
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
  const read = (orgId: string) =>
    app
      .get(OrgScope)
      .run(orgId, () => app.get(SqlOrgEntitlementRepository).readSnapshot());
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RepoModule,
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
});
