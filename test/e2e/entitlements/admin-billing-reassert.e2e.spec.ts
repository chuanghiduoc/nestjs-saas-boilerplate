import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import {
  PlanAssignments,
  type AssignmentResult,
} from '../../../src/modules/entitlements/index.js';
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
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const SUB = 'sub_1';

describe('AD-5: billing reasserts the plan every paid period against staff actions (spec SP4 §10.3, S4-D11, R-X18)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let staff: SeededPrincipal;
  const orgs: SeededOrg[] = [];
  /** "Transaction billing" của SP5: UoW + OrgScope, không principal (job của SP5) → actor `system` `billing`. */
  const billing = (
    orgId: string,
    planKey: string,
    sequence: bigint,
  ): Promise<AssignmentResult> =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() =>
        app.get(PlanAssignments).assign({
          planKey,
          cause: { kind: 'BILLING', ref: SUB, sequence },
        }),
      ),
    );
  const admin = (o: SeededOrg) => `/v1/admin/orgs/${o.orgId}/entitlements`;
  const etag = async (o: SeededOrg): Promise<string> =>
    String(
      (
        await request(app.getHttpServer())
          .get(admin(o))
          .set('authorization', `Bearer ${staff.bearer}`)
      ).headers.etag,
    );
  /** ETag đọc TRƯỚC khi dựng request PUT: supertest đóng server tạm của request GET khi nó xong, PUT đang dựng sẽ ECONNREFUSED. */
  const staffPut = async (o: SeededOrg, path: string, body: object) => {
    const ifMatch = await etag(o);
    return request(app.getHttpServer())
      .put(`${admin(o)}${path}`)
      .set('authorization', `Bearer ${staff.bearer}`)
      .set('if-match', ifMatch)
      .send(body);
  };
  const billedOrg = async () => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, 'free', {
      source: 'BILLING',
      sourceRef: SUB,
      lastBillingSeq: 1n,
    });
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule],
    });
    staff = await seedStaffPrincipal();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    if (staff) await deleteSeededPrincipals([staff]);
    await disposeCatalogue?.();
  });

  it('(a) the billed plan is retired: REJECTED_RETIRED each period; the staff plan set in between stays; last_billing_seq advances', async () => {
    const o = await billedOrg();
    expect(await billing(o.orgId, 'legacy', 2n)).toEqual({
      kind: 'REJECTED_RETIRED',
      planKey: 'legacy',
    });
    const put = await staffPut(o, '/plan', {
      planKey: 'pro',
      reason: 'rejected-retired runbook',
    });
    expect([put.status, put.body.plan.source]).toEqual([200, 'PLATFORM_ADMIN']);
    expect(await billing(o.orgId, 'legacy', 3n)).toEqual({
      kind: 'REJECTED_RETIRED',
      planKey: 'legacy',
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'pro',
      source: 'PLATFORM_ADMIN',
      lastBillingSeq: '3',
    });
  });
  it('(b)+(c) staff moves a billed org to pro; the next paid period reasserts free → APPLIED back to BILLING (billing actor), the earlier override stays; the period after is UNCHANGED', async () => {
    const o = await billedOrg();
    expect(
      (
        await staffPut(o, '/overrides/fixture.projects', {
          limit: 7,
          reason: 'pilot',
          expiresAt: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (await staffPut(o, '/plan', { planKey: 'pro', reason: 'goodwill' }))
        .status,
    ).toBe(200);
    expect(await billing(o.orgId, 'free', 2n)).toEqual({
      kind: 'APPLIED',
      fromPlan: 'pro',
      toPlan: 'free',
      version: 4,
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'free',
      source: 'BILLING',
      sourceRef: SUB,
      reason: null,
    });
    expect(
      (await outboxOf(o.orgId, 'entitlements.plan.changed')).map((e) => [
        e.payload.cause,
        e.headers.actorType,
        e.headers.actorId,
      ]),
    ).toEqual([
      ['PLATFORM_ADMIN', 'user', staff.authUserId],
      ['BILLING', 'system', 'billing'],
    ]);
    expect(
      (await readOverrides(o.orgId)).map((r) => [r.feature, r.limitValue]),
    ).toEqual([['fixture.projects', 7]]);
    // (c): kỳ kế tiếp nữa, cùng gói cùng subscription → UNCHANGED: không version, không event, chỉ ghi nhận seq.
    expect(await billing(o.orgId, 'free', 3n)).toEqual({
      kind: 'UNCHANGED',
      version: 4,
    });
    expect(await outboxOf(o.orgId, 'entitlements.plan.changed')).toHaveLength(
      2,
    );
    expect((await readOrgEntitlement(o.orgId))?.lastBillingSeq).toBe('3');
  });
  it('(d) staff assigns the very plan billing pays for; the next period reasserts it → APPLIED with fromPlan = toPlan, source back to BILLING', async () => {
    const o = await billedOrg();
    const put = await staffPut(o, '/plan', {
      planKey: 'free',
      reason: 'manual confirmation',
    });
    expect([put.status, put.headers.etag, put.body.plan.source]).toEqual([
      200,
      'W/"2"',
      'PLATFORM_ADMIN',
    ]);
    expect(await billing(o.orgId, 'free', 2n)).toEqual({
      kind: 'APPLIED',
      fromPlan: 'free',
      toPlan: 'free',
      version: 3,
    });
    expect((await readOrgEntitlement(o.orgId))?.source).toBe('BILLING');
  });
});
