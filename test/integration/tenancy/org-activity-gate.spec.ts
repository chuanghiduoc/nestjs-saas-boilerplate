import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope } from '../../../src/core/database/index.js';
import { OrgActivityGate } from '../../../src/core/queue/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('TenancyOrgActivityGate (spec SP3 §9.4, T-34)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });
  const check = (orgId: string) =>
    app.get(OrgScope).run(orgId, () => app.get(OrgActivityGate).check());

  it('ACTIVE, then DELETED with deleted_at, and GONE for an org without a row', async () => {
    expect(await check(org.orgId)).toEqual({ kind: 'ACTIVE' });
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
    const deleted = await check(org.orgId);
    expect(deleted.kind).toBe('DELETED');
    expect(await check(v7())).toEqual({ kind: 'GONE' });
  });
});
