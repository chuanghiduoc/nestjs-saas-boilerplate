import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  readCounters,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import { QuotaRouteModule } from './fixtures/quota-route.module.js';

describe('quota on an @Idempotent() route (spec SP4 §9.2 idempotency, HT-5, QU-4 over HTTP)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  const items = () =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, async () =>
        Number(
          (
            await c.query<{ n: string }>(
              'SELECT count(*)::text AS n FROM fixture_org_items',
            )
          ).rows[0]?.n,
        ),
      ),
    );
  const post = (key: string, fail = false) =>
    authed(app, owner)
      .post(`/v1/orgs/${org.orgId}/fx-quota/reports${fail ? '?fail=1' : ''}`)
      .set('idempotency-key', key)
      .send({});
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule, QuotaRouteModule],
    });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedOrgEntitlement(org.orgId, 'metered');
  });
  afterAll(async () => {
    if (org)
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () => c.query('DELETE FROM fixture_org_items')),
      );
    await org?.dispose();
    await app?.close();
    if (owner) await deleteSeededPrincipals([owner]);
    await disposeCatalogue?.();
  });

  it('HT-5: the same Idempotency-Key twice → the stored response, the quota is consumed once', async () => {
    const key = `k-${v7()}`;
    const first = await post(key);
    const again = await post(key);
    expect([first.status, again.status, again.body]).toEqual([
      201,
      201,
      first.body,
    ]);
    expect((await readCounters(org.orgId)).map((c) => c.used)).toEqual([1]);
    expect(await items()).toBe(1);
  });
  it('QU-4 over HTTP: the handler fails after the consume → 500 and the quota comes back with the side effect', async () => {
    const r = await post(`k-${v7()}`, true);
    expect(r.status).toBe(500);
    expect((await readCounters(org.orgId)).map((c) => c.used)).toEqual([1]);
    expect(await items()).toBe(1);
  });
  it('a new key consumes; at the limit the route answers 422 quota_exceeded with the feature in errors[0]', async () => {
    expect((await post(`k-${v7()}`)).status).toBe(201);
    const full = await post(`k-${v7()}`);
    expect([full.status, full.body.code, full.body.errors?.[0]]).toEqual([
      422,
      'quota_exceeded',
      {
        path: 'feature',
        code: 'fixture.saved_reports',
        message: 'Quota exceeded',
      },
    ]);
    expect((await readCounters(org.orgId)).map((c) => c.used)).toEqual([2]);
    expect(await items()).toBe(2);
  });
});
