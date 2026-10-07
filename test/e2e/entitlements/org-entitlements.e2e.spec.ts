import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { Quotas } from '../../../src/modules/entitlements/index.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  deleteOrgEntitlement,
  periodStartOf,
  seedOrgEntitlement,
  seedPlans,
  setOrgPlan,
} from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('GET /v1/orgs/{orgId}/entitlements (spec SP4 §12.1, HT-2a, HT-3)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  let owner: SeededPrincipal;
  let admin: SeededPrincipal;
  let member: SeededPrincipal;
  let outsider: SeededPrincipal;
  let pro: SeededOrg;
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgOf = async (
    plan: string | undefined,
    opts: Parameters<typeof seedOrgEntitlement>[2] = {},
  ) => {
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule],
    });
    [owner, admin, member, outsider] = [
      await seedP(),
      await seedP(),
      await seedP(),
      await seedP(),
    ];
    pro = await orgOf('pro');
    await seedMember(pro, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(pro, 'MEMBER', { authUserId: member.authUserId });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await disposeCatalogue?.();
  });
  const get = (p: SeededPrincipal, o: SeededOrg) =>
    authed(app, p).get(`/v1/orgs/${o.orgId}/entitlements`);

  it('OWNER, ADMIN and MEMBER read the documented shape: plan, sorted features, deprecated hidden, no ETag', async () => {
    const start = (await periodStartOf(0)).toISOString();
    const end = (await periodStartOf(-1)).toISOString();
    for (const p of [owner, admin, member]) {
      const r = await get(p, pro);
      expect(r.status).toBe(200);
      // Không ETag theo `version` (`etagOf`, W/"<n>"): usage đổi mà version không đổi (4B). ETag yếu mà Express tự băm
      // từ body (`app.set('etag', 'weak')` của core/http) vẫn có và đúng nghĩa, vì nó đổi theo body.
      expect(r.headers.etag).not.toMatch(/^W\/"\d+"$/);
      expect(r.body.plan).toMatchObject({ key: 'pro', source: 'DEFAULT' });
      expect(r.body.features).toEqual([
        {
          key: 'files.storage_bytes',
          kind: 'LIMIT',
          unlimited: false,
          limit: 1_073_741_824,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
        {
          key: 'fixture.api_calls',
          kind: 'QUOTA',
          resetPeriod: 'MONTH',
          unlimited: false,
          limit: 100,
          used: 0,
          state: 'WITHIN',
          periodStart: start,
          periodEnd: end,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
        {
          key: 'fixture.exports',
          kind: 'FLAG',
          enabled: false,
          source: 'PLAN',
          overrideExpiresAt: null,
        },
        {
          key: 'fixture.projects',
          kind: 'LIMIT',
          unlimited: true,
          limit: null,
          source: 'PLAN',
          overrideExpiresAt: null,
        },
        {
          key: 'fixture.reports',
          kind: 'FLAG',
          enabled: true,
          source: 'PLAN',
          overrideExpiresAt: null,
        },
        {
          key: 'fixture.saved_reports',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          unlimited: false,
          limit: 3,
          used: 0,
          state: 'WITHIN',
          periodStart: null,
          periodEnd: null,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
        {
          key: 'tenancy.seats',
          kind: 'LIMIT',
          unlimited: false,
          limit: 10,
          source: 'PLAN',
          overrideExpiresAt: null,
        },
      ]);
    }
  });
  it('a non-member gets the uniform 404 of SP3; without a principal 401', async () => {
    const r = await get(outsider, pro);
    expect([r.status, r.body.code]).toEqual([404, 'not_found']);
    expect(
      (
        await request(app.getHttpServer()).get(
          `/v1/orgs/${pro.orgId}/entitlements`,
        )
      ).status,
    ).toBe(401);
  });
  it('billing source ref and staff reason never reach the tenant body', async () => {
    const billed = await orgOf('enterprise', {
      source: 'BILLING',
      sourceRef: 'sub_do_not_leak',
      lastBillingSeq: 1n,
    });
    const r = await get(owner, billed);
    expect([r.status, r.body.plan.source]).toEqual([200, 'BILLING']);
    expect(JSON.stringify(r.body)).not.toContain('sub_do_not_leak');
  });
  it('HT-3 (first half): an org without its row answers 503 + Retry-After, never a default plan', async () => {
    const o = await orgOf('free');
    await deleteOrgEntitlement(o.orgId);
    const r = await get(owner, o);
    expect([r.status, r.body.code, r.headers['retry-after']]).toEqual([
      503,
      'service_unavailable',
      '5',
    ]);
  });
  it('F-6: an org on a plan this pod does not know answers 503', async () => {
    const disposeGhost = await seedPlans([{ key: 'ghost_http' }]);
    const o = await orgOf('ghost_http');
    try {
      expect((await get(owner, o)).status).toBe(503);
    } finally {
      await o.dispose();
      orgs.splice(orgs.indexOf(o), 1);
      await disposeGhost();
    }
  });
  const consume = (o: SeededOrg, key: string, n: number) =>
    app
      .get(OrgScope)
      .run(o.orgId, () =>
        app.get(UnitOfWork).run(() => app.get(Quotas).consumeOrThrow(key, n)),
      );
  const quotaItem = async (o: SeededOrg, key: string) =>
    ((await get(owner, o)).body.features as { key: string }[]).find(
      (f) => f.key === key,
    );

  it('usage is visible: after consuming 2 of 3 the item says used 2, WITHIN; at 3 REACHED', async () => {
    const o = await orgOf('metered');
    await consume(o, 'fixture.api_calls', 2);
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({
      limit: 3,
      used: 2,
      state: 'WITHIN',
    });
    await consume(o, 'fixture.api_calls', 1);
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({
      used: 3,
      state: 'REACHED',
    });
  });
  it('Review Focus 3: OVER_LIMIT after a downgrade, release brings the org back under the limit', async () => {
    const o = await orgOf('free');
    const receipt = await consume(o, 'fixture.api_calls', 5);
    await setOrgPlan(o.orgId, 'metered');
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({
      limit: 3,
      used: 5,
      state: 'OVER_LIMIT',
    });
    await expect(consume(o, 'fixture.api_calls', 1)).rejects.toMatchObject({
      error: { code: 'quota_exceeded' },
    });
    await app
      .get(OrgScope)
      .run(o.orgId, () =>
        app.get(UnitOfWork).run(() => app.get(Quotas).release(receipt)),
      );
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({
      used: 0,
      state: 'WITHIN',
    });
    await expect(consume(o, 'fixture.api_calls', 1)).resolves.toMatchObject({
      amount: 1,
    });
  });
  it('HT-2c: a member whose custom role lacks entitlements.read gets 403 forbidden; with it, 200', async () => {
    const without = await seedCustomRole(pro, { permissions: ['org.read'] });
    const withRead = await seedCustomRole(pro, {
      permissions: ['org.read', 'entitlements.read'],
    });
    const p1 = await seedP();
    const p2 = await seedP();
    await seedMemberInRole(pro, without, { authUserId: p1.authUserId });
    await seedMemberInRole(pro, withRead, { authUserId: p2.authUserId });
    const r1 = await get(p1, pro);
    expect([r1.status, r1.body.code]).toEqual([403, 'forbidden']);
    expect((await get(p2, pro)).status).toBe(200);
  });
});
