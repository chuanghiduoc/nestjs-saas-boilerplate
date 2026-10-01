import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import {
  Db,
  OrgScope,
  UnitOfWork,
  pgFields,
} from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import {
  EntitlementsRowMissingError,
  PlanAssignments,
  type AssignmentResult,
} from '../../../src/modules/entitlements/index.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  holdEntitlementRow,
  waitForBlocked,
} from '../../support/entitlements-races.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  readOrgEntitlement,
  seedOrgEntitlement,
  withOwner,
} from '../../support/entitlements-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RUNS = 50;
const DEADLOCK = '40P01';
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'race',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('race'),
});

describe('plan assignment races with a row-lock barrier (spec SP4 §17 E-5, E-7, E-16; PA-9, PA-15)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  }, 120_000);
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await withOwner((c) =>
      c.query(
        'DELETE FROM fixture_billing_accounts WHERE org_ref = ANY($1::uuid[])',
        [orgs.map((o) => o.orgId)],
      ),
    );
    await app?.close();
    await disposeCatalogue?.();
  });
  /**
   * `lockAccount`: khoá dòng account của caller trước (vai SP5, PA-15). PA-9 tắt nó: hai lệnh cùng org sẽ xếp hàng ở khoá
   * account (cơ chế CHÍNH của E-5) thay vì ở `org_entitlements`; PA-9 kiểm lớp chặn CUỐI (khoá `org_entitlements` + so seq).
   */
  const billingTx = (
    orgId: string,
    planKey: string,
    sequence: bigint,
    lockAccount = true,
  ): Promise<AssignmentResult | Error> =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(async () => {
        if (lockAccount)
          await app
            .get(Db)
            .execute(
              `UPDATE fixture_billing_accounts SET plan_assignment_seq = plan_assignment_seq + 1, updated_at = now() WHERE org_ref = ?::uuid`,
              [orgId],
            );
        return app
          .get(PlanAssignments)
          .assign({
            planKey,
            cause: { kind: 'BILLING', ref: 'sub_1', sequence },
          })
          .catch((e: unknown) =>
            e instanceof Error ? e : new Error(String(e)),
          );
      }),
    );

  it(`PA-9 (E-5): commands with sequences 6 and 7 racing on one row always end on the plan of 7, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await seedOrg();
      orgs.push(o);
      await seedOrgEntitlement(o.orgId, 'free', {
        source: 'BILLING',
        sourceRef: 'sub_1',
        lastBillingSeq: 5n,
      });
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [
        billingTx(o.orgId, 'pro', 6n, false),
        billingTx(o.orgId, 'enterprise', 7n, false),
      ];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const results = await Promise.all(racing);
      expect(
        results.filter((r) => r instanceof Error),
        `run ${i}`,
      ).toEqual([]);
      const kinds = results
        .map((r) => (r instanceof Error ? 'error' : r.kind))
        .sort();
      expect(
        [
          ['APPLIED', 'APPLIED'],
          ['APPLIED', 'STALE'],
        ],
        `run ${i}`,
      ).toContainEqual(kinds);
      expect(await readOrgEntitlement(o.orgId), `run ${i}`).toMatchObject({
        planKey: 'enterprise',
        lastBillingSeq: '7',
      });
    }
  }, 300_000);

  it('C2 (deterministic): a plan change committed while assign waits on the row lock → STALE or APPLIED on the new row, never EntitlementsRowMissingError', async () => {
    const cases = [
      {
        sequence: 6n,
        kind: 'STALE',
        end: { planKey: 'enterprise', lastBillingSeq: '7' },
      },
      {
        sequence: 8n,
        kind: 'APPLIED',
        end: { planKey: 'pro', lastBillingSeq: '8' },
      },
    ] as const;
    for (const c of cases) {
      const o = await seedOrg();
      orgs.push(o);
      await seedOrgEntitlement(o.orgId, 'free', {
        source: 'BILLING',
        sourceRef: 'sub_1',
        lastBillingSeq: 5n,
      });
      const holder = await holdEntitlementRow(o.orgId);
      const waiting = billingTx(o.orgId, 'pro', c.sequence, false);
      await waitForBlocked(holder.pid, 1);
      // Phiên giữ khoá đổi `plan_id` (free → enterprise, seq 7) rồi COMMIT: đúng tình huống làm câu khoá có JOIN trả 0 dòng.
      await holder.commitWith(
        `UPDATE org_entitlements SET plan_id = (SELECT id FROM plans WHERE key = 'enterprise'), plan_source = 'BILLING', last_billing_seq = 7,
                version = version + 1, updated_at = now() WHERE org_id = app_current_org()`,
      );
      const result = await waiting;
      expect(result, `sequence ${c.sequence}`).not.toBeInstanceOf(
        EntitlementsRowMissingError,
      );
      expect(
        result instanceof Error ? result.constructor.name : result.kind,
        `sequence ${c.sequence}`,
      ).toBe(c.kind);
      expect(
        await readOrgEntitlement(o.orgId),
        `sequence ${c.sequence}`,
      ).toMatchObject(c.end);
    }
  });

  it(`E-7: two staff commands with the same expected version → exactly one APPLIED, the other 412 re-checked under the lock, ×${RUNS}`, async () => {
    const staff = v7();
    for (let i = 0; i < RUNS; i++) {
      const o = await seedOrg();
      orgs.push(o);
      await seedOrgEntitlement(o.orgId, 'free');
      const staffTx = (planKey: string): Promise<unknown> =>
        app
          .get(OrgScope)
          .run(o.orgId, () =>
            app.get(UnitOfWork).run(() => {
              app.get(RequestContext).setPrincipal({ type: 'user', id: staff });
              return app.get(PlanAssignments).assign({
                planKey,
                cause: {
                  kind: 'PLATFORM_ADMIN',
                  reason: 'race',
                  expectedVersion: 1,
                },
              });
            }),
          )
          .catch((e: unknown) => e);
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [staffTx('pro'), staffTx('enterprise')];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const results = await Promise.all(racing);
      expect(
        results.filter(
          (r) =>
            r instanceof AppError && r.error.code === 'precondition_failed',
        ),
        `run ${i}`,
      ).toHaveLength(1);
      expect(
        results.filter((r) => !(r instanceof Error)),
        `run ${i}`,
      ).toEqual([expect.objectContaining({ kind: 'APPLIED', version: 2 })]);
      expect((await readOrgEntitlement(o.orgId))?.version, `run ${i}`).toBe(2);
    }
  }, 300_000);

  it(`PA-15 (E-16): purge racing a billing transaction that holds its account lock never deadlocks, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await seedOrg();
      await seedOrgEntitlement(o.orgId, 'free', {
        source: 'BILLING',
        sourceRef: 'sub_1',
        lastBillingSeq: 1n,
      });
      await withOwner((c) =>
        c.query('INSERT INTO fixture_billing_accounts (org_ref) VALUES ($1)', [
          o.orgId,
        ]),
      );
      await withAppClient((c) =>
        inOrgTx(c, o.orgId, () =>
          c.query(
            `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
            [o.orgId],
          ),
        ),
      );
      const holder = await holdEntitlementRow(o.orgId);
      const assign = billingTx(o.orgId, 'pro', 2n);
      const purge = app
        .get(OrgScope)
        .run(o.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(o.orgId)))
        .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const [a, p] = await Promise.all([assign, purge]);
      for (const r of [a, p])
        expect(
          r instanceof Error ? pgFields(r)?.sqlState : undefined,
          `run ${i}`,
        ).not.toBe(DEADLOCK);
      expect(p, `run ${i}`).toBe('purged');
      if (a instanceof Error)
        expect(a, `run ${i}`).toBeInstanceOf(EntitlementsRowMissingError);
      else
        expect(a, `run ${i}`).toMatchObject({ kind: 'APPLIED', toPlan: 'pro' });
      expect(await readOrgEntitlement(o.orgId), `run ${i}`).toBeUndefined();
      // Transaction "billing" vẫn commit câu UPDATE của chính nó (spec PA-15), dù `assign` áp trước purge hay gặp dòng đã mất.
      const account = await withOwner((c) =>
        c.query<{ seq: string }>(
          'SELECT plan_assignment_seq::text AS seq FROM fixture_billing_accounts WHERE org_ref = $1',
          [o.orgId],
        ),
      );
      expect(account.rows, `run ${i}`).toEqual([{ seq: '1' }]);
      await withOwner((c) =>
        c.query('DELETE FROM fixture_billing_accounts WHERE org_ref = $1', [
          o.orgId,
        ]),
      );
      await o.dispose();
    }
  }, 300_000);
});
