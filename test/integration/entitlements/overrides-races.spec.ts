import { Logger, type INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import {
  Db,
  OrgScope,
  UnitOfWork,
  pgFields,
} from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { SqlOverrideRepository } from '../../../src/modules/entitlements/infra/sql/sql-override.repository.js';
import type { AdminView } from '../../../src/modules/entitlements/application/admin-entitlements.query.js';
import { AdminEntitlements } from '../../../src/modules/entitlements/application/admin-entitlements.service.js';
import { Overrides } from '../../../src/modules/entitlements/application/overrides.service.js';
import {
  PlanAssignments,
  Quotas,
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
  waitForBlocked,
} from '../../support/entitlements-races.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
  seedOverride,
} from '../../support/entitlements-seed.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const RUNS = 50;
const DEADLOCK = '40P01';
const STAFF = '0198c000-0000-7000-8000-00000000c7a3';
/** Hạn chót cho "không bị khoá chặn": dưới idle_in_transaction_session_timeout 10 s (như quotas-races của 4B). */
const NOT_BLOCKED_MS = 3_000;
const v1 = 'W/"1"';
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
/** Tên kết quả: mã `AppError`, SQLSTATE, tên lớp lỗi, hoặc `ok`. */
const outcome = (r: unknown): string =>
  r instanceof AppError
    ? r.error.code
    : r instanceof Error
      ? (pgFields(r)?.sqlState ?? `error:${r.name}`)
      : 'ok';
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

describe('override and staff plan races with row-lock barriers (spec SP4 §17)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const asStaff = <T>(fn: () => Promise<T>) =>
    app.get(ClsService).run(() => {
      app.get(RequestContext).setPrincipal({ type: 'user', id: STAFF });
      return fn();
    });
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  const setOverride = (
    orgId: string,
    key: string,
    limit: number | null,
    ifMatch = v1,
  ) =>
    settle(
      asStaff(() =>
        app.get(AdminEntitlements).setOverride(orgId, key, ifMatch, {
          value: { limit },
          reason: 'race',
          expiresAt: null,
        }),
      ),
    );
  const assignPlan = (orgId: string, planKey: string, ifMatch = v1) =>
    settle(
      asStaff(() =>
        app
          .get(AdminEntitlements)
          .assignPlan(orgId, ifMatch, { planKey, reason: 'race' }),
      ),
    );
  const billing = (orgId: string, planKey: string, sequence: bigint) =>
    settle(
      inTx(orgId, () =>
        app.get(PlanAssignments).assign({
          planKey,
          cause: { kind: 'BILLING', ref: 'sub_1', sequence },
        }),
      ),
    );
  const consume = (orgId: string, key: string, n = 1) =>
    settle(inTx(orgId, () => app.get(Quotas).consume(key, n)));
  /** Override của nhân viên mở dở: ghi xong (khoá gốc + dòng + version) rồi chờ `release`; trả pid để `waitForBlocked`. */
  const openOverrideWrite = (orgId: string, key: string, limit: number) => {
    const written = gate();
    const release = gate();
    let pid = -1;
    const done = settle(
      asStaff(() =>
        inTx(orgId, async () => {
          const v = await app
            .get(Overrides)
            .set(
              key,
              { value: { limit }, reason: 'race', expiresAt: null },
              v1,
            );
          const [row] = await app
            .get(Db)
            .execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          pid = row?.pid ?? -1;
          written.open();
          await release.wait;
          return v;
        }),
      ),
    );
    return {
      written: written.wait,
      release: release.open,
      done,
      pid: () => pid,
    };
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
  const orgOn = async (
    plan: string,
    opts: Parameters<typeof seedOrgEntitlement>[2] = {},
  ) => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  const versionsOf = async (orgId: string) =>
    (
      await Promise.all(
        ['entitlements.override.set', 'entitlements.plan.changed'].map((t) =>
          outboxOf(orgId, t),
        ),
      )
    )
      .flat()
      .map((e) => e.aggregate_version)
      .sort();
  beforeAll(async () => {
    // UnitOfWork chạy lại transaction ngoài cùng khi gặp 40P01 (DB_TX_RETRY_ATTEMPTS): nạn nhân của một deadlock sẽ chạy lại
    // âm thầm và kết quả cuối vẫn "đúng", nên ca "không bao giờ 40P01" thành rỗng. Tắt retry để deadlock lộ ra thành 40P01
    // (đã thấy: bỏ câu khoá gốc của purge mà ca C2 ép xen kẽ vẫn xanh khi còn retry).
    vi.stubEnv('DB_TX_RETRY_ATTEMPTS', '0');
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  }, 120_000);
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
    vi.unstubAllEnvs();
  });
  /**
   * Cửa TRƯỚC câu ghi dòng con (review vòng 2, I-3): spy trên CHÍNH instance repository của app (mẫu `armOverrideUpsert` của
   * chaos), chặn ngay đầu `upsert`/`remove` rồi gọi bản gốc. Lúc cửa đóng, nhân viên đã giữ khoá gốc nhưng CHƯA chạm dòng con:
   * đúng xen kẽ gây `40P01` nếu purge xoá dòng con trước rồi mới tới gốc.
   */
  const gateBeforeChildWrite = (op: 'upsert' | 'remove') => {
    const reached = gate();
    const release = gate();
    let pid = -1;
    const hold = async () => {
      const [row] = await app
        .get(Db)
        .execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      pid = row?.pid ?? -1;
      reached.open();
      await release.wait;
    };
    const repo = app.get(SqlOverrideRepository);
    if (op === 'upsert') {
      const original = repo.upsert.bind(repo);
      vi.spyOn(repo, 'upsert').mockImplementationOnce(async (w) => {
        await hold();
        return original(w);
      });
    } else {
      const original = repo.remove.bind(repo);
      vi.spyOn(repo, 'remove').mockImplementationOnce(async (featureId) => {
        await hold();
        return original(featureId);
      });
    }
    return { reached: reached.wait, release: release.open, pid: () => pid };
  };

  it(`E-7: two staff PUTs of one override with the same ETag → exactly one wins, one 412; the winner's value and one event, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('pro');
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [
        setOverride(o.orgId, 'fixture.projects', 3),
        setOverride(o.orgId, 'fixture.projects', 4),
      ];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const rs = await Promise.all(racing);
      expect(rs.map(outcome).sort(), `run ${i}`).toEqual([
        'ok',
        'precondition_failed',
      ]);
      const winner = rs.find((r): r is AdminView => !(r instanceof Error));
      expect(
        (await readOverrides(o.orgId)).map((r) => r.limitValue),
        `run ${i}`,
      ).toEqual([winner?.overrides[0]?.limitValue]);
      expect(
        (await outboxOf(o.orgId, 'entitlements.override.set')).map(
          (e) => e.aggregate_version,
        ),
        `run ${i}`,
      ).toEqual(['2']);
    }
  }, 300_000);
  it(`E-7: two staff plan PUTs with the same ETag → one 200, one 412 counted as precondition_failed; the plan is the winner's, ×${RUNS}`, async () => {
    const before =
      (await otel.metric('entitlements_plan_assignments_total', {
        cause: 'PLATFORM_ADMIN',
        result: 'precondition_failed',
      })) ?? 0;
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('free');
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [
        assignPlan(o.orgId, 'pro'),
        assignPlan(o.orgId, 'enterprise'),
      ];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const rs = await Promise.all(racing);
      expect(rs.map(outcome).sort(), `run ${i}`).toEqual([
        'ok',
        'precondition_failed',
      ]);
      const winner = rs.find((r): r is AdminView => !(r instanceof Error));
      expect((await readOrgEntitlement(o.orgId))?.planKey, `run ${i}`).toBe(
        winner?.snapshot.plan.key,
      );
      expect(
        await outboxOf(o.orgId, 'entitlements.plan.changed'),
        `run ${i}`,
      ).toHaveLength(1);
    }
    expect(
      await otel.metric('entitlements_plan_assignments_total', {
        cause: 'PLATFORM_ADMIN',
        result: 'precondition_failed',
      }),
    ).toBe(before + RUNS);
  }, 300_000);
  it(`E-7: an override PUT and a plan PUT with the same ETag → one wins, one 412 (one aggregate, one lock), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('free');
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [
        setOverride(o.orgId, 'tenancy.seats', 2),
        assignPlan(o.orgId, 'pro'),
      ];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      expect(
        (await Promise.all(racing)).map(outcome).sort(),
        `run ${i}`,
      ).toEqual(['ok', 'precondition_failed']);
      expect((await readOrgEntitlement(o.orgId))?.version, `run ${i}`).toBe(2);
    }
  }, 300_000);
  it('E-8 (forced, override first): a billing command waits on the open override write, then applies on top of it; the override stays and versions are 2 then 3', async () => {
    const o = await orgOn('free', {
      source: 'BILLING',
      sourceRef: 'sub_1',
      lastBillingSeq: 1n,
    });
    const w = openOverrideWrite(o.orgId, 'fixture.projects', 9);
    await w.written;
    const billed = billing(o.orgId, 'pro', 2n);
    await waitForBlocked(w.pid(), 1);
    w.release();
    expect(await w.done).toBe(2);
    expect(await billed).toEqual({
      kind: 'APPLIED',
      fromPlan: 'free',
      toPlan: 'pro',
      version: 3,
    });
    expect((await readOverrides(o.orgId)).map((r) => r.limitValue)).toEqual([
      9,
    ]);
    expect(await versionsOf(o.orgId)).toEqual(['2', '3']);
  });
  it(`E-8: staff override ∥ billing command → billing always applies; the staff write wins its race or gets 412 (never a lost update, never a deadlock), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('free', {
        source: 'BILLING',
        sourceRef: 'sub_1',
        lastBillingSeq: 1n,
      });
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [
        setOverride(o.orgId, 'fixture.projects', 5),
        billing(o.orgId, 'pro', 2n),
      ];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const [staffWrite, billed] = await Promise.all(racing);
      expect(outcome(billed), `run ${i}`).toBe('ok');
      expect(['ok', 'precondition_failed'], `run ${i}`).toContain(
        outcome(staffWrite),
      );
      const applied = outcome(staffWrite) === 'ok';
      expect(
        (await readOverrides(o.orgId)).map((r) => r.limitValue),
        `run ${i}`,
      ).toEqual(applied ? [5] : []);
      expect(await readOrgEntitlement(o.orgId), `run ${i}`).toMatchObject({
        planKey: 'pro',
        source: 'BILLING',
        version: applied ? 3 : 2,
      });
      expect(await versionsOf(o.orgId), `run ${i}`).toEqual(
        applied ? ['2', '3'] : ['2'],
      );
    }
  }, 300_000);
  it('E-4/E-15 (forced, override first): a consume completes while an override write holds the root row, with the old limit; after the commit the next consume sees the new one (OVER_LIMIT is valid)', async () => {
    const o = await orgOn('metered');
    const w = openOverrideWrite(o.orgId, 'fixture.api_calls', 1);
    await w.written;
    const timer = blockedTimer();
    try {
      const c = await Promise.race([
        consume(o.orgId, 'fixture.api_calls', 2),
        timer.promise,
      ]);
      expect(c === 'blocked' || c instanceof Error ? c : c.kind).toBe(
        'CONSUMED',
      );
    } finally {
      timer.cancel();
      w.release();
    }
    expect(await w.done).toBe(2);
    expect(await consume(o.orgId, 'fixture.api_calls', 1)).toEqual({
      kind: 'EXCEEDED',
      limit: 1,
      used: 2,
    });
  });
  it('E-4/E-15 (forced, consume first): an override write completes while an open consume holds its counter and FOR KEY SHARE on the root row', async () => {
    const o = await orgOn('metered');
    const consumed = gate();
    const release = gate();
    const consuming = settle(
      inTx(o.orgId, async () => {
        const r = await app.get(Quotas).consume('fixture.api_calls', 1);
        consumed.open();
        await release.wait;
        return r;
      }),
    );
    await consumed.wait;
    const timer = blockedTimer();
    try {
      const w = await Promise.race([
        setOverride(o.orgId, 'fixture.api_calls', 2),
        timer.promise,
      ]);
      expect(w === 'blocked' ? w : outcome(w)).toBe('ok');
    } finally {
      timer.cancel();
      release.open();
    }
    expect(outcome(await consuming)).toBe('ok');
  });
  it('E-6b: an override write never waits on the organizations row lock that MemberAdmission holds (lock order §3.6)', async () => {
    const o = await orgOn('metered');
    const admission = await holdInOrg(
      o.orgId,
      'SELECT 1 FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE',
      [],
      1,
    );
    const timer = blockedTimer();
    try {
      const w = await Promise.race([
        setOverride(o.orgId, 'tenancy.seats', 1),
        timer.promise,
      ]);
      expect(w === 'blocked' ? w : outcome(w)).toBe('ok');
    } finally {
      timer.cancel();
      await admission.release();
    }
  });
  // Purge khoá dòng gốc trước (câu đầu của ENTITLEMENTS_PURGE_STATEMENTS, review 4C C2): ghi trước thì purge chờ ở câu khoá,
  // rồi các câu DELETE chạy với snapshot mới và xoá cả dòng vừa commit — một lần, không 23001. 23001 ở đây là lỗi: có một
  // đường ghi dòng con không chờ khoá gốc.
  it('E-11c (deterministic, new override first): an open override write holds the root row while the purge waits on the root lock → the purge then removes everything in one pass', async () => {
    const o = await orgOn('pro');
    await softDeleteDue(o.orgId);
    const w = openOverrideWrite(o.orgId, 'fixture.projects', 3);
    await w.written;
    const purging = purgeOnce(o.orgId);
    await waitForBlocked(w.pid(), 1);
    w.release();
    expect(await w.done).toBe(2);
    expect(await purging).toBe('purged');
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it.each(['upsert', 'remove'] as const)(
    'C2 (forced, existing override): staff %s holds the root lock but has not touched the child row yet; the purge waits on the root → no 40P01, purged once the write commits',
    async (op) => {
      const o = await orgOn('pro');
      await seedOverride(o.orgId, 'fixture.projects', { value: { limit: 2 } });
      await softDeleteDue(o.orgId);
      const g = gateBeforeChildWrite(op);
      const writing =
        op === 'upsert'
          ? setOverride(o.orgId, 'fixture.projects', 9)
          : settle(
              asStaff(() =>
                app
                  .get(AdminEntitlements)
                  .removeOverride(o.orgId, 'fixture.projects', 'race', v1),
              ),
            );
      await g.reached;
      const purging = purgeOnce(o.orgId);
      await waitForBlocked(g.pid(), 1);
      g.release();
      const [w, p] = await Promise.all([writing, purging]);
      for (const r of [w, p]) expect(outcome(r)).not.toBe(DEADLOCK);
      expect(outcome(w)).toBe('ok');
      expect(p).toBe('purged');
      expect(await readOverrides(o.orgId)).toEqual([]);
    },
  );
  it.each(['upsert', 'delete'] as const)(
    'C2 (forced, existing override, purge first): the purge holds the root row; the staff %s waits, then answers 404 once the purge commits',
    async (op) => {
      const o = await orgOn('pro');
      await seedOverride(o.orgId, 'fixture.projects', { value: { limit: 2 } });
      const purger = await holdInOrg(
        o.orgId,
        'SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR UPDATE',
        [],
        1,
      );
      const writing =
        op === 'upsert'
          ? setOverride(o.orgId, 'fixture.projects', 9)
          : settle(
              asStaff(() =>
                app
                  .get(AdminEntitlements)
                  .removeOverride(o.orgId, 'fixture.projects', 'race', v1),
              ),
            );
      await waitForBlocked(purger.pid, 1);
      // Mảng tham số rỗng: node-pg dùng giao thức simple, nên hai câu chạy trong một lần gọi (như purge: con trước cha).
      await purger.commitWith(
        'DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org(); DELETE FROM org_entitlements WHERE org_id = app_current_org()',
      );
      expect(outcome(await writing)).toBe('not_found');
      expect(await readOverrides(o.orgId)).toEqual([]);
    },
  );
  it('E-11c (deterministic, purge first): the purge deleted the root row uncommitted → the waiting override write answers 404 once it commits', async () => {
    const o = await orgOn('pro');
    const purger = await holdInOrg(
      o.orgId,
      'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
      [],
      1,
    );
    const writing = setOverride(o.orgId, 'fixture.projects', 3);
    await waitForBlocked(purger.pid, 1);
    await purger.commitWith('SELECT 1');
    expect(outcome(await writing)).toBe('not_found');
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it(`E-11c: purge ∥ override write → no deadlock; the write is 404 or its row is removed by the purge, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('pro');
      await softDeleteDue(o.orgId);
      const [p, w] = await Promise.all([
        purgeOnce(o.orgId),
        setOverride(o.orgId, 'fixture.projects', 3),
      ]);
      for (const r of [p, w]) expect(outcome(r), `run ${i}`).not.toBe(DEADLOCK);
      expect(['ok', 'not_found'], `run ${i}`).toContain(outcome(w));
      // Purge khoá gốc trước (C2): không còn nhánh 23001 + retry (review vòng 2, M-1).
      expect(p, `run ${i}`).toBe('purged');
      expect(await readOverrides(o.orgId), `run ${i}`).toEqual([]);
    }
  }, 300_000);
  it(`C2: purge ∥ staff write on an EXISTING override (upsert or DELETE) → never 40P01; the write wins its race or is 404, the purge removes everything, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('pro');
      await seedOverride(o.orgId, 'fixture.projects', { value: { limit: 2 } });
      await softDeleteDue(o.orgId);
      const staffWrite =
        i % 2 === 0
          ? setOverride(o.orgId, 'fixture.projects', 9)
          : settle(
              asStaff(() =>
                app
                  .get(AdminEntitlements)
                  .removeOverride(o.orgId, 'fixture.projects', 'race', v1),
              ),
            );
      const [p, w] = await Promise.all([purgeOnce(o.orgId), staffWrite]);
      for (const r of [p, w]) expect(outcome(r), `run ${i}`).not.toBe(DEADLOCK);
      expect(['ok', 'not_found'], `run ${i}`).toContain(outcome(w));
      expect(p, `run ${i}`).toBe('purged');
      expect(await readOverrides(o.orgId), `run ${i}`).toEqual([]);
    }
  }, 300_000);
});
