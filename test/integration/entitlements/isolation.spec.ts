import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  Db,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import { createTestApp } from '../../support/app-factory.js';
import {
  readOrgEntitlement,
  seedOrgEntitlement,
  seedPlans,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

describe('tenant isolation of org_entitlements through the app (spec SP4 criterion 8, DB-2)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  let disposePlans: () => Promise<void>;
  const inA = <T>(fn: () => Promise<T>) =>
    app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) =>
    app.get(Db).execute<T>(q, p);
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    disposePlans = await seedPlans([{ key: 'iso_plan' }]);
    a = await seedOrg();
    b = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'iso_plan');
    await seedOrgEntitlement(b.orgId, 'iso_plan');
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await disposePlans?.();
    await app?.close();
  });

  it('read/update/delete of org B from OrgScope(A) touch 0 rows and leave B unchanged', async () => {
    const before = await readOrgEntitlement(b.orgId);
    expect(
      await inA(() =>
        sql('SELECT 1 FROM org_entitlements WHERE org_id = ?', [b.orgId]),
      ),
    ).toEqual([]);
    expect(
      await inA(() =>
        sql(
          'UPDATE org_entitlements SET version = version + 1 WHERE org_id = ? RETURNING 1',
          [b.orgId],
        ),
      ),
    ).toEqual([]);
    expect(
      await inA(() =>
        sql('DELETE FROM org_entitlements WHERE org_id = ? RETURNING 1', [
          b.orgId,
        ]),
      ),
    ).toEqual([]);
    expect(await readOrgEntitlement(b.orgId)).toEqual(before);
  });
  it('INSERT with org_id = B from OrgScope(A) is refused by RLS', async () => {
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT ?, id, 'DEFAULT', now() FROM plans WHERE key = 'iso_plan'`,
          [b.orgId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it('without an org context the table fails closed (P0001)', async () => {
    await expect(
      app.get(UnitOfWork).run(() => sql('SELECT 1 FROM org_entitlements')),
    ).rejects.toThrow(/org context is not set/);
  });
});
