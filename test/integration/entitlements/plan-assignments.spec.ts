import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  PlanAssignments,
  UnknownPlanError,
  type AssignPlanCommand,
} from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  readOrgEntitlement,
  seedOrgEntitlement,
  seedPlans,
  withOwner,
} from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const STAFF = v7();
const billing = (
  planKey: string,
  sequence: bigint,
  ref = 'sub_1',
): AssignPlanCommand => ({
  planKey,
  cause: { kind: 'BILLING', ref, sequence },
});
const admin = (
  planKey: string,
  expectedVersion: number,
  reason = 'goodwill credit',
): AssignPlanCommand => ({
  planKey,
  cause: { kind: 'PLATFORM_ADMIN', reason, expectedVersion },
});

describe('PlanAssignments.assign (spec SP4 §10, R-X1, R-X18, C-2)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  /** Một "transaction billing" (hoặc admin nếu có `staff`) trong UoW + OrgScope của org, như caller thật (spec §10.3). */
  const assignIn = (orgId: string, cmd: AssignPlanCommand, staff?: string) =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() => {
        if (staff)
          app.get(RequestContext).setPrincipal({ type: 'user', id: staff });
        return app.get(PlanAssignments).assign(cmd);
      }),
    );
  const events = (orgId: string) =>
    ownerQuery<{
      payload: Record<string, unknown>;
      headers: Record<string, string>;
      aggregate_version: string;
    }>(
      `SELECT payload, headers, aggregate_version::text AS aggregate_version FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed' ORDER BY id`,
      [orgId],
    );
  const orgOn = async (
    plan: string,
    opts: Parameters<typeof seedOrgEntitlement>[2] = {},
  ) => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('PA-16 (R-X18): the per-period reassertion chain — applied, renewal unchanged, staff, billing takes the slot back, same plan applied', async () => {
    const o = await orgOn('free');
    expect(await assignIn(o.orgId, billing('pro', 1n))).toEqual({
      kind: 'APPLIED',
      fromPlan: 'free',
      toPlan: 'pro',
      version: 2,
    });
    expect(await assignIn(o.orgId, billing('pro', 2n))).toEqual({
      kind: 'UNCHANGED',
      version: 2,
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'pro',
      source: 'BILLING',
      lastBillingSeq: '2',
      version: 2,
    });
    expect(await assignIn(o.orgId, admin('free', 2), STAFF)).toEqual({
      kind: 'APPLIED',
      fromPlan: 'pro',
      toPlan: 'free',
      version: 3,
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'free',
      source: 'PLATFORM_ADMIN',
      sourceRef: null,
      reason: 'goodwill credit',
      lastBillingSeq: '2',
    });
    expect(await assignIn(o.orgId, billing('pro', 3n))).toEqual({
      kind: 'APPLIED',
      fromPlan: 'free',
      toPlan: 'pro',
      version: 4,
    });
    expect(await assignIn(o.orgId, admin('pro', 4), STAFF)).toEqual({
      kind: 'APPLIED',
      fromPlan: 'pro',
      toPlan: 'pro',
      version: 5,
    });
    expect(await assignIn(o.orgId, billing('pro', 4n))).toEqual({
      kind: 'APPLIED',
      fromPlan: 'pro',
      toPlan: 'pro',
      version: 6,
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'pro',
      source: 'BILLING',
      sourceRef: 'sub_1',
      reason: null,
      lastBillingSeq: '4',
      version: 6,
    });
    const e = await events(o.orgId);
    expect(
      e.map((x) => [
        x.payload.cause,
        x.payload.fromPlan,
        x.payload.toPlan,
        x.aggregate_version,
      ]),
    ).toEqual([
      ['BILLING', 'free', 'pro', '2'],
      ['PLATFORM_ADMIN', 'pro', 'free', '3'],
      ['BILLING', 'free', 'pro', '4'],
      ['PLATFORM_ADMIN', 'pro', 'pro', '5'],
      ['BILLING', 'pro', 'pro', '6'],
    ]);
    expect(e.map((x) => x.headers.actorId)).toEqual([
      'billing',
      STAFF,
      'billing',
      STAFF,
      'billing',
    ]);
    expect(e[0]?.payload.causeRef).toBe('sub_1');
    expect(e[1]?.payload.causeRef).toBeNull();
    // Phần "override đặt giữa chuỗi còn nguyên ở cuối" của PA-16 chạy ở 4C (bảng override thuộc 4C).
  });
  it('PA-13: REJECTED_RETIRED and UNCHANGED from billing record the sequence without version or event; a smaller one is then STALE', async () => {
    const o = await orgOn('enterprise', {
      source: 'BILLING',
      sourceRef: 'sub_1',
      lastBillingSeq: 1n,
    });
    expect(await assignIn(o.orgId, billing('legacy', 5n))).toEqual({
      kind: 'REJECTED_RETIRED',
      planKey: 'legacy',
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'enterprise',
      lastBillingSeq: '5',
      version: 1,
    });
    expect(await assignIn(o.orgId, billing('enterprise', 6n))).toEqual({
      kind: 'UNCHANGED',
      version: 1,
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      lastBillingSeq: '6',
      version: 1,
    });
    expect(await assignIn(o.orgId, billing('pro', 4n))).toEqual({
      kind: 'STALE',
      lastBillingSeq: 6n,
    });
    expect(await events(o.orgId)).toEqual([]);
  });
  it('PA-10 (E-8): staff assigns, a later billing sequence wins; an older billing command arriving afterwards is STALE', async () => {
    const o = await orgOn('free', {
      source: 'BILLING',
      sourceRef: 'sub_1',
      lastBillingSeq: 3n,
    });
    await assignIn(o.orgId, admin('enterprise', 1), STAFF);
    expect(await assignIn(o.orgId, billing('pro', 4n))).toMatchObject({
      kind: 'APPLIED',
      fromPlan: 'enterprise',
      toPlan: 'pro',
    });
    expect(await assignIn(o.orgId, billing('free', 2n))).toEqual({
      kind: 'STALE',
      lastBillingSeq: 4n,
    });
    expect((await readOrgEntitlement(o.orgId))?.planKey).toBe('pro');
  });
  it('staff: a stale If-Match version is 412 before any write; a retired target is REJECTED_RETIRED without any write', async () => {
    const o = await orgOn('free');
    const labels = { cause: 'PLATFORM_ADMIN', result: 'precondition_failed' };
    const before =
      (await otel.metric('entitlements_plan_assignments_total', labels)) ?? 0;
    const err: unknown = await assignIn(o.orgId, admin('pro', 7), STAFF).catch(
      (e: unknown) => e,
    );
    expect(err instanceof AppError ? err.error.code : undefined).toBe(
      'precondition_failed',
    );
    expect(
      await otel.metric('entitlements_plan_assignments_total', labels),
    ).toBe(before + 1);
    expect(await assignIn(o.orgId, admin('legacy', 1), STAFF)).toEqual({
      kind: 'REJECTED_RETIRED',
      planKey: 'legacy',
    });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'free',
      source: 'DEFAULT',
      version: 1,
      lastBillingSeq: null,
    });
  });
  it('Review Focus 3: billing sequences beyond 2^53 compare exactly', async () => {
    const o = await orgOn('free');
    const big = 2n ** 53n + 1n;
    expect(await assignIn(o.orgId, billing('pro', big))).toMatchObject({
      kind: 'APPLIED',
    });
    expect(
      await assignIn(o.orgId, billing('enterprise', big + 1n)),
    ).toMatchObject({ kind: 'APPLIED' });
    expect(await assignIn(o.orgId, billing('free', big))).toEqual({
      kind: 'STALE',
      lastBillingSeq: big + 1n,
    });
    expect((await readOrgEntitlement(o.orgId))?.lastBillingSeq).toBe(
      (big + 1n).toString(),
    );
  });
  it('Review Focus 2: assign works on an org whose current plan is unknown to this pod (never EntitlementsVersionSkewError)', async () => {
    const disposeGhost = await seedPlans([{ key: 'ghost_assign' }]);
    const o = await seedOrg();
    try {
      await seedOrgEntitlement(o.orgId, 'ghost_assign');
      expect(await assignIn(o.orgId, billing('pro', 1n))).toEqual({
        kind: 'APPLIED',
        fromPlan: 'ghost_assign',
        toPlan: 'pro',
        version: 2,
      });
    } finally {
      await o.dispose();
      await disposeGhost();
    }
  });
  it('PA-14 (C-2): named errors come before the first write, so the caller transaction keeps working and commits', async () => {
    const withRow = await orgOn('free');
    const noRow = await seedOrg();
    orgs.push(noRow);
    for (const org of [withRow.orgId, noRow.orgId])
      await withOwner((c) =>
        c.query('INSERT INTO fixture_billing_accounts (org_ref) VALUES ($1)', [
          org,
        ]),
      );
    const caught: unknown[] = [];
    /** Vai transaction billing của SP5: khoá account TRƯỚC (thứ tự §3.6), gọi `assign`, rồi ghi tiếp và COMMIT. */
    const billingTx = (orgId: string, cmd: AssignPlanCommand) =>
      app.get(OrgScope).run(orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const db = app.get(Db);
          const bump = () =>
            db.execute(
              `UPDATE fixture_billing_accounts SET plan_assignment_seq = plan_assignment_seq + 1, updated_at = now() WHERE org_ref = ?::uuid`,
              [orgId],
            );
          await bump();
          await app
            .get(PlanAssignments)
            .assign(cmd)
            .catch((e: unknown) => caught.push(e));
          await bump();
        }),
      );
    const seqOf = async (orgId: string) =>
      withOwner(
        async (c) =>
          (
            await c.query<{ seq: string }>(
              'SELECT plan_assignment_seq::text AS seq FROM fixture_billing_accounts WHERE org_ref = $1',
              [orgId],
            )
          ).rows[0]?.seq,
      );
    // (a) key không có trong catalogue gói của pod.
    await billingTx(withRow.orgId, billing('platinum', 1n));
    // (b) org không có dòng `org_entitlements`.
    await billingTx(noRow.orgId, billing('pro', 1n));
    // (c) key có trong catalogue nhưng dòng `plans` chưa có (migration gói chưa chạy): xoá dòng `legacy` SAU khi app boot
    //     (không org nào ở `legacy`), khôi phục trong `finally` để catalogue check của file sau đạt.
    await withOwner((c) => c.query(`DELETE FROM plans WHERE key = 'legacy'`));
    try {
      await billingTx(withRow.orgId, billing('legacy', 1n));
    } finally {
      await seedPlans([{ key: 'legacy', retired: true }]);
    }
    expect(
      caught.map((e) => (e instanceof Error ? e.constructor.name : typeof e)),
    ).toEqual([
      'UnknownPlanError',
      'EntitlementsRowMissingError',
      'UnknownPlanError',
    ]);
    expect(caught[0]).toBeInstanceOf(UnknownPlanError);
    expect(caught[1]).toBeInstanceOf(EntitlementsRowMissingError);
    expect([await seqOf(withRow.orgId), await seqOf(noRow.orgId)]).toEqual([
      '4',
      '2',
    ]);
    expect(await readOrgEntitlement(withRow.orgId)).toMatchObject({
      planKey: 'free',
      version: 1,
      lastBillingSeq: null,
    });
    await withOwner((c) =>
      c.query(
        'DELETE FROM fixture_billing_accounts WHERE org_ref = ANY($1::uuid[])',
        [[withRow.orgId, noRow.orgId]],
      ),
    );
  });
  it('malformed commands are validation_failed before any SQL; missing context is an EntitlementsContextError', async () => {
    const o = await orgOn('free');
    for (const cmd of [
      billing('pro', 0n),
      billing('pro', 1n, ''),
      billing('pro', 1n, 'r'.repeat(129)),
      admin('pro', 1, ' padded '),
      admin('pro', 1, '😀'.repeat(501)),
    ]) {
      const err: unknown = await assignIn(o.orgId, cmd, STAFF).catch(
        (e: unknown) => e,
      );
      expect(err instanceof AppError ? err.error.code : err).toBe(
        'validation_failed',
      );
    }
    expect(
      await assignIn(o.orgId, admin('pro', 1, '😀'.repeat(500)), STAFF),
    ).toMatchObject({ kind: 'APPLIED' });
    await expect(
      app
        .get(OrgScope)
        .run(o.orgId, () =>
          app.get(PlanAssignments).assign(billing('pro', 9n)),
        ),
    ).rejects.toBeInstanceOf(EntitlementsContextError);
    await expect(assignIn(o.orgId, admin('free', 2))).rejects.toBeInstanceOf(
      EntitlementsContextError,
    );
    expect(app.get(PlanAssignments).defaultPlanKey()).toBe('free');
  });
  it('the staff reason never reaches logs, spans or metrics; the event carries it (R-X31); the metric counts by cause and result', async () => {
    const o = await orgOn('free');
    const reason = `secret-reason-${v7()}`;
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (...args: unknown[]) => void lines.push(JSON.stringify(args)),
      );
    otel.reset();
    await assignIn(o.orgId, admin('pro', 1, reason), STAFF);
    expect(lines.join('\n')).not.toContain(reason);
    expect(
      JSON.stringify(
        otel.spans('entitlements.plan.assign').map((s) => s.attributes),
      ),
    ).not.toContain(reason);
    expect((await events(o.orgId)).map((e) => e.payload.reason)).toEqual([
      reason,
    ]);
    expect(
      await otel.metric('entitlements_plan_assignments_total', {
        cause: 'PLATFORM_ADMIN',
        result: 'applied',
      }),
    ).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });
});
