import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Db,
  OrgScope,
  UnitOfWork,
  pgFields,
} from '../../../src/core/database/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import {
  EntitlementsRowMissingError,
  PlanAssignments,
  Quotas,
  type ConsumeResult,
} from '../../../src/modules/entitlements/index.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  holdEntitlementRow,
  holdInOrg,
  holdUsageCounter,
  holdUsageCounterInsert,
  waitForBlocked,
} from '../../support/entitlements-races.js';
import {
  QUOTA_TZ,
  periodStartOf,
  readCounters,
  seedCounter,
  seedOrgEntitlement,
  setOrgPlan,
} from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RUNS = 50;
const DEADLOCK = '40P01';
const RESTRICT = '23001';
const FK_VIOLATION = '23503';
/** Hạn chót cho "consume không bị khoá org_entitlements chặn" (E-15): dưới idle_in_transaction_session_timeout 10 s. */
const NOT_BLOCKED_MS = 3_000;
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'race',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('race'),
});
const settle = <T>(p: Promise<T>): Promise<T | Error> =>
  p.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
/** Một cửa: `wait` chờ tới khi `open()`; ép thứ tự xen kẽ bên trong `UnitOfWork.run` của code thật, không ngủ. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
/** `promise` thành `'blocked'` sau `NOT_BLOCKED_MS`; `cancel()` trong `finally` để không để lại timer sau `Promise.race`. */
function blockedTimer(): { promise: Promise<'blocked'>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'blocked'>((resolve) => {
    handle = setTimeout(() => resolve('blocked'), NOT_BLOCKED_MS);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

describe('quota races with a row-lock barrier (spec SP4 §17)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const consume = (orgId: string, key: string, n = 1) =>
    settle(
      app
        .get(OrgScope)
        .run(orgId, () =>
          app.get(UnitOfWork).run(() => app.get(Quotas).consume(key, n)),
        ),
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
  const softDeleteDue = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(c, orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
          [orgId],
        ),
      ),
    );
  const purgeOnce = (orgId: string) =>
    settle(
      app
        .get(OrgScope)
        .run(orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(orgId))),
    );
  const kinds = (rs: (ConsumeResult | Error)[]) =>
    rs.map((r) => (r instanceof Error ? `error:${r.name}` : r.kind)).sort();
  const reachedCount = async (orgId: string) =>
    (
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.quota.reached'`,
        [orgId],
      )
    ).length;
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  }, 120_000);
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it(`QU-1 (E-1): 6 parallel consume(1) with 3 left → exactly 3 CONSUMED, 3 EXCEEDED, used = 3, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await seedCounter(o.orgId, 'fixture.api_calls', {
        used: 0,
        period: { monthsAgo: 0 },
      });
      const holder = await holdUsageCounter(
        o.orgId,
        'fixture.api_calls',
        QUOTA_TZ,
      );
      const racing = Array.from({ length: 6 }, () =>
        consume(o.orgId, 'fixture.api_calls'),
      );
      await waitForBlocked(holder.pid, 6);
      await holder.release();
      expect(kinds(await Promise.all(racing)), `run ${i}`).toEqual([
        'CONSUMED',
        'CONSUMED',
        'CONSUMED',
        'EXCEEDED',
        'EXCEEDED',
        'EXCEEDED',
      ]);
      expect(
        (await readCounters(o.orgId)).map((c) => c.used),
        `run ${i}`,
      ).toEqual([3]);
    }
  }, 300_000);
  it(`QU-2 (E-2): the first two consumes of a new period race on a row that does not exist yet → one row, used = 2, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      const holder = await holdUsageCounterInsert(
        o.orgId,
        'fixture.saved_reports',
        null,
      );
      const racing = [
        consume(o.orgId, 'fixture.saved_reports'),
        consume(o.orgId, 'fixture.saved_reports'),
      ];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      expect(kinds(await Promise.all(racing)), `run ${i}`).toEqual([
        'CONSUMED',
        'CONSUMED',
      ]);
      expect(
        (await readCounters(o.orgId)).map((c) => [
          c.periodStart,
          c.used,
          c.version,
        ]),
        `run ${i}`,
      ).toEqual([[null, 2, 2]]);
    }
  }, 300_000);
  it(`QU-6 (E-10): 5 parallel consume(1) reaching a limit of 3 → exactly one quota.reached, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await seedCounter(o.orgId, 'fixture.api_calls', {
        used: 0,
        period: { monthsAgo: 0 },
      });
      const holder = await holdUsageCounter(
        o.orgId,
        'fixture.api_calls',
        QUOTA_TZ,
      );
      const racing = Array.from({ length: 5 }, () =>
        consume(o.orgId, 'fixture.api_calls'),
      );
      await waitForBlocked(holder.pid, 5);
      await holder.release();
      await Promise.all(racing);
      expect(await reachedCount(o.orgId), `run ${i}`).toBe(1);
    }
  }, 300_000);
  it(`QU-7 (E-14): release ∥ consume on a full counter → used stays in [0, limit] and matches the outcome, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await seedCounter(o.orgId, 'fixture.api_calls', {
        used: 3,
        period: { monthsAgo: 0 },
      });
      const receipt = {
        orgId: o.orgId,
        featureKey: 'fixture.api_calls',
        periodStart: (await periodStartOf(0)).toISOString(),
        amount: 1,
      };
      const holder = await holdUsageCounter(
        o.orgId,
        'fixture.api_calls',
        QUOTA_TZ,
      );
      const released = settle(
        app
          .get(OrgScope)
          .run(o.orgId, () =>
            app.get(UnitOfWork).run(() => app.get(Quotas).release(receipt)),
          ),
      );
      const consumed = consume(o.orgId, 'fixture.api_calls');
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const [r, c] = await Promise.all([released, consumed]);
      expect(r, `run ${i}`).toBeUndefined();
      const used = (await readCounters(o.orgId))[0]?.used;
      if (c instanceof Error) throw c;
      expect(used, `run ${i}`).toBe(c.kind === 'CONSUMED' ? 3 : 2);
    }
  }, 300_000);
  it('QU-8 (E-4): a downgrade between two consumes → the next one is EXCEEDED with the real usage (OVER_LIMIT is valid)', async () => {
    const o = await orgOn('free');
    expect(
      (await consume(o.orgId, 'fixture.api_calls', 5)) instanceof Error,
    ).toBe(false);
    await setOrgPlan(o.orgId, 'metered');
    expect(await consume(o.orgId, 'fixture.api_calls')).toEqual({
      kind: 'EXCEEDED',
      limit: 3,
      used: 5,
    });
    expect((await readCounters(o.orgId)).map((c) => c.used)).toEqual([5]);
  });
  it('E-15 (forced, assign first): a consume completes while an open assign transaction holds org_entitlements FOR NO KEY UPDATE', async () => {
    const o = await orgOn('metered', {
      source: 'BILLING',
      sourceRef: 'sub_1',
      lastBillingSeq: 1n,
    });
    const locked = gate();
    const release = gate();
    const assigning = settle(
      app.get(OrgScope).run(o.orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const r = await app.get(PlanAssignments).assign({
            planKey: 'unmetered',
            cause: { kind: 'BILLING', ref: 'sub_1', sequence: 2n },
          });
          locked.open();
          await release.wait;
          return r;
        }),
      ),
    );
    await locked.wait;
    const timer = blockedTimer();
    try {
      const c = await Promise.race([
        consume(o.orgId, 'fixture.api_calls'),
        timer.promise,
      ]);
      expect(c === 'blocked' || c instanceof Error ? c : c.kind).toBe(
        'CONSUMED',
      );
    } finally {
      timer.cancel();
      release.open();
    }
    const a = await assigning;
    expect(a instanceof Error ? a.message : a.kind).toBe('APPLIED');
  });
  it('E-15 (forced, consume first): an assign completes while an open consume transaction holds its counter and FOR KEY SHARE on org_entitlements', async () => {
    const o = await orgOn('metered', {
      source: 'BILLING',
      sourceRef: 'sub_1',
      lastBillingSeq: 1n,
    });
    const consumed = gate();
    const release = gate();
    const consuming = settle(
      app.get(OrgScope).run(o.orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const r = await app.get(Quotas).consume('fixture.api_calls', 1);
          consumed.open();
          await release.wait;
          return r;
        }),
      ),
    );
    await consumed.wait;
    const timer = blockedTimer();
    try {
      const a = await Promise.race([
        settle(
          app.get(OrgScope).run(o.orgId, () =>
            app.get(UnitOfWork).run(() =>
              app.get(PlanAssignments).assign({
                planKey: 'unmetered',
                cause: { kind: 'BILLING', ref: 'sub_1', sequence: 2n },
              }),
            ),
          ),
        ),
        timer.promise,
      ]);
      expect(a === 'blocked' || a instanceof Error ? a : a.kind).toBe(
        'APPLIED',
      );
    } finally {
      timer.cancel();
      release.open();
    }
    const c = await consuming;
    expect(c instanceof Error ? c.message : c.kind).toBe('CONSUMED');
  });
  it(`E-15: billing assign ∥ consume on one org never deadlock, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered', {
        source: 'BILLING',
        sourceRef: 'sub_1',
        lastBillingSeq: 1n,
      });
      const holder = await holdEntitlementRow(o.orgId);
      const assign = settle(
        app.get(OrgScope).run(o.orgId, () =>
          app.get(UnitOfWork).run(() =>
            app.get(PlanAssignments).assign({
              planKey: 'unmetered',
              cause: { kind: 'BILLING', ref: 'sub_1', sequence: 2n },
            }),
          ),
        ),
      );
      const consumed = consume(o.orgId, 'fixture.api_calls');
      await waitForBlocked(holder.pid, 1);
      await holder.release();
      const [a, c] = await Promise.all([assign, consumed]);
      for (const r of [a, c])
        expect(
          r instanceof Error ? (pgFields(r)?.sqlState ?? r.name) : 'ok',
          `run ${i}`,
        ).toBe('ok');
    }
  }, 300_000);
  it(`E-11: purge ∥ consume → no deadlock; the consume is named-failed or its row is removed by the purge (after one retry), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await withAppClient((c) =>
        inOrgTx(c, o.orgId, () =>
          c.query(
            `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
            [o.orgId],
          ),
        ),
      );
      const purge = () =>
        settle(
          app
            .get(OrgScope)
            .run(o.orgId, () =>
              app.get(PurgeOrgHandler).handle(jobCtx(o.orgId)),
            ),
        );
      const [p, c] = await Promise.all([
        purge(),
        consume(o.orgId, 'fixture.api_calls'),
      ]);
      for (const r of [p, c])
        expect(
          r instanceof Error ? pgFields(r)?.sqlState : undefined,
          `run ${i}`,
        ).not.toBe(DEADLOCK);
      if (c instanceof Error)
        expect(
          c instanceof EntitlementsRowMissingError ||
            pgFields(c)?.sqlState === FK_VIOLATION,
          `run ${i}: ${c.message}`,
        ).toBe(true);
      // Consume chèn bộ đếm TRƯỚC khi purge xoá dòng gốc: kiểm RESTRICT của purge thấy dòng mới → purge fail to, job retry.
      if (p instanceof Error) {
        expect(pgFields(p)?.sqlState, `run ${i}`).toBe(RESTRICT);
        expect(await purge(), `run ${i}`).toBe('purged');
      } else expect(p, `run ${i}`).toBe('purged');
      expect(await readCounters(o.orgId), `run ${i}`).toEqual([]);
    }
  }, 300_000);
  it('E-11 (deterministic, consume first): an open consume holds its new counter while the purge waits on the root lock → the purge then removes the committed counter in one pass', async () => {
    const o = await orgOn('metered');
    await softDeleteDue(o.orgId);
    const inserted = gate();
    const release = gate();
    let pid = -1;
    const consuming = settle(
      app.get(OrgScope).run(o.orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const r = await app.get(Quotas).consume('fixture.api_calls', 1);
          const [row] = await app
            .get(Db)
            .execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          pid = row?.pid ?? -1;
          inserted.open();
          await release.wait;
          return r;
        }),
      ),
    );
    await inserted.wait;
    const purging = purgeOnce(o.orgId);
    await waitForBlocked(pid, 1);
    release.open();
    const c = await consuming;
    expect(c instanceof Error ? c.message : c.kind).toBe('CONSUMED');
    expect(await purging).toBe('purged');
    expect(await readCounters(o.orgId)).toEqual([]);
  });
  it('E-11 (deterministic, purge first): the purge deleted the root row uncommitted → the waiting consume fails 23503 once it commits', async () => {
    const o = await orgOn('metered');
    const purger = await holdInOrg(
      o.orgId,
      'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
      [],
      1,
    );
    const consuming = consume(o.orgId, 'fixture.api_calls');
    await waitForBlocked(purger.pid, 1);
    await purger.commitWith('SELECT 1');
    const c = await consuming;
    expect(
      c instanceof Error ? [pgFields(c)?.sqlState, pgFields(c)?.constraint] : c,
    ).toEqual([FK_VIOLATION, 'usage_counters_org_fk']);
    expect(await readCounters(o.orgId)).toEqual([]);
  });
  // Hồi quy, không phải test đỏ-trước: chỉ chạy thứ tự an toàn. Luật "thứ tự key tăng dần" là QUY ƯỚC của caller (spec §3.6,
  // README), code không ép; ca này khoá điều Quotas bảo đảm: consume không lấy khoá nào ngoài dòng bộ đếm và FOR KEY SHARE
  // của FK, nên theo đúng quy ước thì không có chu trình.
  it(`I2 (regression): two transactions consuming two counters in ascending key order never deadlock (consume takes no extra locks), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      const both = () =>
        settle(
          app.get(OrgScope).run(o.orgId, () =>
            app.get(UnitOfWork).run(async () => {
              // Thứ tự key tăng dần (spec §3.6, I2): `fixture.api_calls` < `fixture.saved_reports`.
              for (const key of ['fixture.api_calls', 'fixture.saved_reports'])
                await app.get(Quotas).consume(key, 1);
              return 'ok' as const;
            }),
          ),
        );
      const rs = await Promise.all([both(), both()]);
      expect(
        rs.map((r) =>
          r instanceof Error ? (pgFields(r)?.sqlState ?? r.message) : r,
        ),
        `run ${i}`,
      ).toEqual(['ok', 'ok']);
    }
  }, 300_000);
});
