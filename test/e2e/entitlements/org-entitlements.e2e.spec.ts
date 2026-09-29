import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  deleteOrgEntitlement,
  seedOrgEntitlement,
  seedPlans,
} from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedMember,
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
    for (const p of [owner, admin, member]) {
      const r = await get(p, pro);
      expect(r.status).toBe(200);
      // Không ETag theo `version` (`etagOf`, W/"<n>"): usage đổi mà version không đổi (4B). ETag yếu mà Express tự băm
      // từ body (`app.set('etag', 'weak')` của core/http) vẫn có và đúng nghĩa, vì nó đổi theo body.
      expect(r.headers.etag).not.toMatch(/^W\/"\d+"$/);
      expect(r.body.plan).toMatchObject({ key: 'pro', source: 'DEFAULT' });
      expect(r.body.features).toEqual([
        {
          key: 'fixture.api_calls',
          kind: 'QUOTA',
          resetPeriod: 'MONTH',
          unlimited: false,
          limit: 100,
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
});
