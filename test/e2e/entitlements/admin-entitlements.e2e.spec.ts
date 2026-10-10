import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import {
  ENTITLEMENT_VALUE_MAX,
  REASON_MAX_LENGTH,
} from '../../../src/modules/entitlements/constants.js';
import { Quotas } from '../../../src/modules/entitlements/index.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedCounter,
  seedOrgEntitlement,
  seedOverride,
  withOwner,
} from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedOrg,
  seedOrgApiKey,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

type Item = { key: string } & Record<string, unknown>;
const MINUTE_MS = 60_000;
const feature = (body: { features: Item[] }, key: string) =>
  body.features.find((f) => f.key === key);

describe('admin entitlements API (spec SP4 §12.2; AD-2, AD-3, AD-4; Review Focus 2–5; review 4C)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let staff: SeededPrincipal;
  let owner: SeededPrincipal;
  const orgs: SeededOrg[] = [];
  const call = (
    method: 'get' | 'put' | 'delete',
    path: string,
    o: { ifMatch?: string; body?: object; ifNoneMatch?: string } = {},
  ) => {
    let req = request(app.getHttpServer())
      [method](path)
      .set('authorization', `Bearer ${staff.bearer}`);
    if (o.ifMatch !== undefined) req = req.set('if-match', o.ifMatch);
    if (o.ifNoneMatch !== undefined)
      req = req.set('if-none-match', o.ifNoneMatch);
    return o.body === undefined ? req : req.send(o.body);
  };
  const orgOn = async (
    plan: string | undefined,
    opts: Parameters<typeof seedOrgEntitlement>[2] = {},
  ) => {
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  const base = (o: SeededOrg) => `/v1/admin/orgs/${o.orgId}/entitlements`;
  const tenantView = (o: SeededOrg) =>
    authed(app, owner).get(`/v1/orgs/${o.orgId}/entitlements`);
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule],
    });
    staff = await seedStaffPrincipal();
    owner = await seedUserPrincipal();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals([staff, owner].filter(Boolean));
    await disposeCatalogue?.();
  });

  it('GET /v1/admin/plans: the pod catalogue — default, retired, effective values per plan (PLAN or FALLBACK), deprecated hidden, no-store', async () => {
    const r = await call('get', '/v1/admin/plans');
    expect([r.status, r.headers['cache-control']]).toEqual([200, 'no-store']);
    const plan = (k: string) =>
      (
        r.body.plans as ({ key: string; features: Item[] } & Record<
          string,
          unknown
        >)[]
      ).find((p) => p.key === k);
    expect(r.body.defaultPlan).toBe('free');
    expect(r.body.plans.map((p: { key: string }) => p.key)).toEqual(
      [...fixturePlans.plans.keys()].sort(),
    );
    expect(plan('legacy')).toMatchObject({ retired: true, default: false });
    expect(plan('free')).toMatchObject({ retired: false, default: true });
    expect(feature(plan('pro')!, 'tenancy.seats')).toEqual({
      key: 'tenancy.seats',
      kind: 'LIMIT',
      unlimited: false,
      limit: 10,
      source: 'PLAN',
      overrideExpiresAt: null,
    });
    expect(feature(plan('free')!, 'fixture.api_calls')).toEqual({
      key: 'fixture.api_calls',
      kind: 'QUOTA',
      resetPeriod: 'MONTH',
      unlimited: false,
      limit: 100,
      source: 'FALLBACK',
      overrideExpiresAt: null,
    });
    expect(feature(plan('free')!, 'fixture.legacy_pdf')).toBeUndefined();
  });
  it('GET …/entitlements: internal fields, usage like the tenant (OVER_LIMIT), ETag W/"version", no-store; If-None-Match equal to the ETag is still 200 with the body (Spec-I2); unknown org, malformed id, org without a row → 404', async () => {
    const o = await orgOn('metered', {
      source: 'BILLING',
      sourceRef: 'sub_9',
      lastBillingSeq: 3n,
    });
    await seedOverride(o.orgId, 'fixture.projects', {
      value: { limit: 4 },
      reason: 'trial extension',
      expiresInSec: -60,
    });
    await seedCounter(o.orgId, 'fixture.api_calls', {
      used: 5,
      period: { monthsAgo: 0 },
    });
    const r = await call('get', base(o));
    expect([r.status, r.headers.etag, r.headers['cache-control']]).toEqual([
      200,
      'W/"1"',
      'no-store',
    ]);
    expect(r.body).toMatchObject({
      orgId: o.orgId,
      version: 1,
      plan: {
        key: 'metered',
        source: 'BILLING',
        sourceRef: 'sub_9',
        reason: null,
      },
      lastBillingSeq: '3',
    });
    expect(feature(r.body, 'fixture.projects')).toMatchObject({
      unlimited: false,
      limit: 2,
      source: 'FALLBACK',
    });
    expect(feature(r.body, 'fixture.api_calls')).toMatchObject({
      limit: 3,
      used: 5,
      state: 'OVER_LIMIT',
    });
    expect(r.body.overrides).toEqual([
      {
        feature: 'fixture.projects',
        kind: 'LIMIT',
        unlimited: false,
        limit: 4,
        reason: 'trial extension',
        expiresAt: expect.stringMatching(/Z$/),
        status: 'EXPIRED',
        updatedAt: expect.stringMatching(/Z$/),
      },
    ]);
    const conditional = await call('get', base(o), { ifNoneMatch: 'W/"1"' });
    expect([conditional.status, conditional.body.version]).toEqual([200, 1]);
    expect(
      (await call('get', `/v1/admin/orgs/${v7()}/entitlements`)).status,
    ).toBe(404);
    expect(
      (await call('get', '/v1/admin/orgs/not-a-uuid/entitlements')).status,
    ).toBe(404);
    expect((await call('get', base(await orgOn(undefined)))).status).toBe(404);
  });
  it('AD-2: PUT …/plan — no If-Match or * → 428, stale 412, retired 422 plan_retired, unknown 422 unknown_plan; success 200 + new ETag + a staff event carrying the reason (R-X31); the same plan and reason again is unchanged; a new reason is applied (M1)', async () => {
    const o = await orgOn('free');
    const put = (body: object, ifMatch?: string) =>
      call('put', `${base(o)}/plan`, { body, ifMatch });
    const good = { planKey: 'pro', reason: 'sales-approved-uplift-8821' };
    const refusals = [
      await put(good),
      await put(good, '*'),
      await put(good, 'W/"7"'),
      await put({ ...good, planKey: 'legacy' }, 'W/"1"'),
      await put({ ...good, planKey: 'gold' }, 'W/"1"'),
    ];
    expect(refusals.map((r) => [r.status, r.body.code])).toEqual([
      [428, 'precondition_required'],
      [428, 'precondition_required'],
      [412, 'precondition_failed'],
      [422, 'plan_retired'],
      [422, 'unknown_plan'],
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
    const ok = await put(good, 'W/"1"');
    expect([ok.status, ok.headers.etag]).toEqual([200, 'W/"2"']);
    expect(ok.body.plan).toMatchObject({
      key: 'pro',
      source: 'PLATFORM_ADMIN',
      reason: good.reason,
      sourceRef: null,
    });
    const again = await put(good, 'W/"2"');
    expect([again.status, again.headers.etag]).toEqual([200, 'W/"2"']);
    const staleSame = await put(good, 'W/"1"');
    expect([staleSame.status, staleSame.headers.etag]).toEqual([200, 'W/"2"']);
    const staleOther = await put(
      { ...good, reason: 'uplift extended to Q4' },
      'W/"1"',
    );
    expect([staleOther.status, staleOther.body.code]).toEqual([
      412,
      'precondition_failed',
    ]);
    const renamed = await put(
      { ...good, reason: 'uplift extended to Q4' },
      'W/"2"',
    );
    expect([
      renamed.status,
      renamed.headers.etag,
      renamed.body.plan.reason,
    ]).toEqual([200, 'W/"3"', 'uplift extended to Q4']);
    const events = await outboxOf(o.orgId, 'entitlements.plan.changed');
    expect(
      events.map((e) => [
        e.payload.cause,
        e.payload.fromPlan,
        e.payload.toPlan,
        e.payload.reason,
        e.headers.actorType,
        e.headers.actorId,
        e.aggregate_version,
      ]),
    ).toEqual([
      [
        'PLATFORM_ADMIN',
        'free',
        'pro',
        good.reason,
        'user',
        staff.authUserId,
        '2',
      ],
      [
        'PLATFORM_ADMIN',
        'pro',
        'pro',
        'uplift extended to Q4',
        'user',
        staff.authUserId,
        '3',
      ],
    ]);
  });
  it('AD-3: PUT …/overrides/{key} — wrong kind, below minimum, past expiry → 422 on the field; unknown or deprecated key → 404; set → tenant sees OVERRIDE; DELETE without a reason → 422, with one → 204 + event with the reason; again → 404', async () => {
    const o = await orgOn('pro');
    const put = (key: string, body: object, ifMatch = 'W/"1"') =>
      call('put', `${base(o)}/overrides/${key}`, { body, ifMatch });
    const why = { reason: 'support ticket 4410', expiresAt: null };
    const refusals = [
      await put('fixture.reports', { limit: 3, ...why }),
      await put('tenancy.seats', { limit: 0, ...why }),
      await put('tenancy.seats', { enabled: true, ...why }),
      await put('tenancy.seats', {
        limit: 2,
        reason: why.reason,
        expiresAt: new Date(Date.now() - MINUTE_MS).toISOString(),
      }),
      await put('fixture.nope', { enabled: true, ...why }),
      await put('fixture.legacy_pdf', { enabled: true, ...why }),
    ];
    expect(refusals.map((r) => [r.status, r.body.errors?.[0]?.path])).toEqual([
      [422, 'limit'],
      [422, 'limit'],
      [422, 'enabled'],
      [422, 'expiresAt'],
      [404, undefined],
      [404, undefined],
    ]);
    // Phán quyết controller (batch 3): `expiresAt` có hơn 3 chữ số thập phân → 422 trên `expiresAt`, không ghi gì.
    const micro = await put('tenancy.seats', {
      limit: 2,
      reason: why.reason,
      expiresAt: new Date(Date.now() + 60 * MINUTE_MS)
        .toISOString()
        .replace('Z', '123Z'),
    });
    expect([micro.status, micro.body.errors?.[0]?.path]).toEqual([
      422,
      'expiresAt',
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
    const set = await put('fixture.reports', { enabled: false, ...why });
    expect([set.status, set.headers.etag]).toEqual([200, 'W/"2"']);
    expect(set.body.overrides).toMatchObject([
      {
        feature: 'fixture.reports',
        kind: 'FLAG',
        enabled: false,
        status: 'ACTIVE',
        expiresAt: null,
      },
    ]);
    expect(
      feature((await tenantView(o)).body, 'fixture.reports'),
    ).toMatchObject({ enabled: false, source: 'OVERRIDE' });
    expect(
      (await outboxOf(o.orgId, 'entitlements.override.set')).map(
        (e) => e.payload,
      ),
    ).toEqual([
      {
        orgId: o.orgId,
        feature: 'fixture.reports',
        value: { kind: 'FLAG', enabled: false },
        expiresAt: null,
        reason: why.reason,
      },
    ]);
    const path = `${base(o)}/overrides/fixture.reports`;
    const noReason = await call('delete', path, { ifMatch: 'W/"2"' });
    expect([noReason.status, noReason.body.code]).toEqual([
      422,
      'validation_failed',
    ]);
    const del = await call('delete', path, {
      ifMatch: 'W/"2"',
      body: { reason: 'ticket 4410 closed' },
    });
    expect([del.status, del.headers.etag]).toEqual([204, 'W/"3"']);
    expect(
      (await outboxOf(o.orgId, 'entitlements.override.removed')).map(
        (e) => e.payload,
      ),
    ).toEqual([
      {
        orgId: o.orgId,
        feature: 'fixture.reports',
        reason: 'ticket 4410 closed',
      },
    ]);
    expect(
      feature((await tenantView(o)).body, 'fixture.reports'),
    ).toMatchObject({ enabled: true, source: 'PLAN' });
    expect(
      (
        await call('delete', path, {
          ifMatch: 'W/"3"',
          body: { reason: 'again' },
        })
      ).status,
    ).toBe(404);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(3);
  });
  it('Spec-I4: PUT of an override is idempotent — the same state again is 200 with the same ETag and no event, also with a stale ETag; another state with a stale ETag is 412', async () => {
    const o = await orgOn('pro');
    const body = { limit: 5, reason: 'retry-safe', expiresAt: null };
    const path = `${base(o)}/overrides/fixture.projects`;
    expect(
      (await call('put', path, { ifMatch: 'W/"1"', body })).headers.etag,
    ).toBe('W/"2"');
    const retried = await call('put', path, { ifMatch: 'W/"1"', body });
    expect([retried.status, retried.headers.etag]).toEqual([200, 'W/"2"']);
    const other = await call('put', path, {
      ifMatch: 'W/"1"',
      body: { ...body, limit: 6 },
    });
    expect([other.status, other.body.code]).toEqual([
      412,
      'precondition_failed',
    ]);
    expect(await outboxOf(o.orgId, 'entitlements.override.set')).toHaveLength(
      1,
    );
  });
  it('AD-3: an override survives a plan change (S4-D11); an expired one reads as PLAN for the tenant and EXPIRED for staff', async () => {
    const o = await orgOn('pro');
    expect(
      (
        await call('put', `${base(o)}/overrides/fixture.projects`, {
          ifMatch: 'W/"1"',
          body: { limit: 7, reason: 'pilot', expiresAt: null },
        })
      ).status,
    ).toBe(200);
    const moved = await call('put', `${base(o)}/plan`, {
      ifMatch: 'W/"2"',
      body: { planKey: 'enterprise', reason: 'pilot plan' },
    });
    expect([moved.status, moved.headers.etag]).toEqual([200, 'W/"3"']);
    expect(feature(moved.body, 'fixture.projects')).toMatchObject({
      unlimited: false,
      limit: 7,
      source: 'OVERRIDE',
    });
    expect((await readOverrides(o.orgId)).map((x) => x.feature)).toEqual([
      'fixture.projects',
    ]);
    const lapsed = await orgOn('pro');
    await seedOverride(lapsed.orgId, 'fixture.reports', {
      value: { enabled: false },
      expiresInSec: -1,
    });
    expect(
      feature((await tenantView(lapsed)).body, 'fixture.reports'),
    ).toMatchObject({ enabled: true, source: 'PLAN' });
    expect((await call('get', base(lapsed))).body.overrides).toMatchObject([
      { feature: 'fixture.reports', status: 'EXPIRED' },
    ]);
  });
  it('AD-4: an org API key on /v1/admin/** → 403 api_key_not_allowed_here; an ordinary session → 403 forbidden', async () => {
    const o = await orgOn('pro');
    const key = await seedOrgApiKey(o, {
      createdByMemberId: o.owner.memberId,
      permissions: ['org.read', 'entitlements.read'],
    });
    const viaKey = await request(app.getHttpServer())
      .get(base(o))
      .set('x-api-key', key.token);
    expect([viaKey.status, viaKey.body.code]).toEqual([
      403,
      'api_key_not_allowed_here',
    ]);
    const plain = await authed(app, owner).get(base(o));
    expect([plain.status, plain.body.code]).toEqual([403, 'forbidden']);
  });
  it('Review Focus 2: reasons are trimmed and measured in code points (500 emoji pass, 501 fail, blanks fail), never a 500', async () => {
    const o = await orgOn('pro');
    let version = 1;
    const put = (reason: string) =>
      call('put', `${base(o)}/overrides/fixture.projects`, {
        ifMatch: `W/"${version}"`,
        body: { limit: 3, reason, expiresAt: null },
      });
    expect((await put('   goodwill   ')).status).toBe(200);
    version += 1;
    expect((await readOverrides(o.orgId))[0]?.reason).toBe('goodwill');
    expect((await put('😀'.repeat(REASON_MAX_LENGTH))).status).toBe(200);
    version += 1;
    for (const bad of ['😀'.repeat(REASON_MAX_LENGTH + 1), '   ', ''])
      expect((await put(bad)).status, `${bad.length} UTF-16 units`).toBe(422);
  });
  it('Review Focus 3: DELETE removes the override of a deprecated feature (cleanup before the feature is dropped)', async () => {
    const o = await orgOn('pro');
    await withOwner((c) =>
      c.query(
        `UPDATE entitlement_features SET deprecated_at = NULL WHERE key = 'fixture.legacy_pdf'`,
      ),
    );
    try {
      await seedOverride(o.orgId, 'fixture.legacy_pdf', {
        value: { enabled: true },
      });
    } finally {
      await withOwner((c) =>
        c.query(
          `UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'fixture.legacy_pdf'`,
        ),
      );
    }
    expect(
      (
        await call('delete', `${base(o)}/overrides/fixture.legacy_pdf`, {
          ifMatch: 'W/"1"',
          body: { reason: 'feature retired' },
        })
      ).status,
    ).toBe(204);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('Review Focus 4: a soft-deleted org stays readable and writable by staff; the purge removes its overrides', async () => {
    const o = await orgOn('pro');
    const r = await withAppClient((c) =>
      inOrgTx(c, o.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`,
          [o.orgId],
        ),
      ),
    );
    expect(r.rowCount).toBe(1);
    expect((await call('get', base(o))).status).toBe(200);
    expect(
      (
        await call('put', `${base(o)}/overrides/tenancy.seats`, {
          ifMatch: 'W/"1"',
          body: { limit: 2, reason: 'retention offer', expiresAt: null },
        })
      ).status,
    ).toBe(200);
    await o.dispose();
    orgs.splice(orgs.indexOf(o), 1);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('Review Focus 5: limit bounds — 2^53 − 1 kept exactly, 2^53 → 422, null on a FLAG → 422, null on a QUOTA is unlimited for consume', async () => {
    const o = await orgOn('metered');
    const put = (key: string, body: object, v: number) =>
      call('put', `${base(o)}/overrides/${key}`, {
        ifMatch: `W/"${v}"`,
        body: { ...body, reason: 'bounds', expiresAt: null },
      });
    const max = await put(
      'fixture.projects',
      { limit: ENTITLEMENT_VALUE_MAX },
      1,
    );
    expect([max.status, feature(max.body, 'fixture.projects')?.limit]).toEqual([
      200,
      ENTITLEMENT_VALUE_MAX,
    ]);
    expect((await put('fixture.projects', { limit: 2 ** 53 }, 2)).status).toBe(
      422,
    );
    const flagNull = await put('fixture.reports', { limit: null }, 2);
    expect([flagNull.status, flagNull.body.errors?.[0]?.path]).toEqual([
      422,
      'limit',
    ]);
    const unlimited = await put('fixture.api_calls', { limit: null }, 2);
    expect(feature(unlimited.body, 'fixture.api_calls')).toMatchObject({
      unlimited: true,
      limit: null,
      source: 'OVERRIDE',
    });
    const consumed = await app
      .get(OrgScope)
      .run(o.orgId, () =>
        app
          .get(UnitOfWork)
          .run(() => app.get(Quotas).consume('fixture.api_calls', 50)),
      );
    expect(consumed.kind).toBe('CONSUMED');
  });
});
