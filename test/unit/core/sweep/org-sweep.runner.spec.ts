import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RequestContext } from '../../../../src/core/context/index.js';
import type { Db, UnitOfWork } from '../../../../src/core/database/index.js';
import {
  defineJob,
  defineQueue,
  type EnqueueItem,
  type JobQueue,
} from '../../../../src/core/queue/index.js';
import {
  DEFINER_LIMIT_MAX,
  OrgSweepDefinitionError,
  OrgSweepRunner,
  PURGE_CURSOR_START,
  defineOrgSweep,
  type OrgSweepBatch,
  type OrgSweepParams,
} from '../../../../src/core/sweep/index.js';

const Q = defineQueue('unit-sweep-run', { kind: 'io' });
const OrgJob = defineJob({
  name: 'unit.sweep-run-org',
  queue: Q,
  version: 1,
  schema: z.object({}),
});
let batch: OrgSweepBatch = { size: 2, maxBatches: 10 };
let params: () => OrgSweepParams = () => ({
  p_tag: 't',
  p_min_age_sec: 60,
  p_strict: true,
});
const Sweep = defineOrgSweep({
  key: 'unit.sweep-run',
  definerFunction: 'unit_orgs_due',
  extraParams: () => params(),
  orgJob: OrgJob,
  jobIdPrefix: 'unit-run',
  schedule: () => ({ cron: '*/5 * * * *', tz: 'UTC' }),
  batch: () => batch,
});
// Cron `*/5 * * * *` UTC → slot 300 s.
const SLOT_SEC = 300;
const AT = new Date('2026-09-29T10:07:00Z');
const org = (n: number) =>
  `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function harness(
  pages: string[][],
  opts: { inTx?: boolean; orgId?: string } = {},
) {
  const sql: string[] = [];
  const args: unknown[][] = [];
  const execute = vi.fn(async (s: string, a: unknown[] = []) => {
    sql.push(s);
    args.push(a);
    return (pages.shift() ?? []).map((org_id) => ({ org_id }));
  });
  const enqueueMany = vi.fn(async (items: EnqueueItem[]) =>
    items.map((i) => i.opts?.jobId ?? ''),
  );
  const runner = new OrgSweepRunner(
    { execute } as Pick<Db, 'execute'> as Db,
    { inTransaction: () => opts.inTx ?? false } as Pick<
      UnitOfWork,
      'inTransaction'
    > as UnitOfWork,
    { orgId: () => opts.orgId } as Pick<
      RequestContext,
      'orgId'
    > as RequestContext,
    { enqueueMany } as Pick<JobQueue, 'enqueueMany'> as JobQueue,
  );
  runner.onModuleInit();
  return { runner, execute, enqueueMany, sql, args };
}

describe('OrgSweepRunner (spec SP6 §5.3 core/sweep, C-8)', () => {
  afterEach(() => {
    batch = { size: 2, maxBatches: 10 };
    params = () => ({ p_tag: 't', p_min_age_sec: 60, p_strict: true });
    vi.restoreAllMocks();
  });
  it('calls the definer with named, explicitly cast parameters and walks the keyset until a short batch', async () => {
    const h = harness([[org(1), org(2)], [org(3), org(4)], [org(5)]]);
    const res = await h.runner.run(Sweep, AT);
    expect(h.sql[0]).toBe(
      'SELECT org_id::text AS org_id FROM public.unit_orgs_due(p_after => ?::uuid, p_limit => ?::integer, p_tag => ?::text, p_min_age_sec => ?::integer, p_strict => ?::boolean)',
    );
    expect(h.args.map((a) => a[0])).toEqual([
      PURGE_CURSOR_START,
      org(2),
      org(4),
    ]);
    expect(h.args[0]).toEqual([PURGE_CURSOR_START, 2, 't', 60, true]);
    const slot = Math.floor(AT.getTime() / 1000 / SLOT_SEC);
    expect(res).toEqual({ batches: 3, enqueued: 5, backlog: false, slot });
    const items = h.enqueueMany.mock.calls.flatMap(([i]) => i);
    expect(
      items.map((i) => [i.job, i.payload, i.opts?.jobId, i.opts?.meta?.orgId]),
    ).toEqual(
      [1, 2, 3, 4, 5].map((n) => [
        OrgJob,
        {},
        `unit-run-${org(n)}-${slot}`,
        org(n),
      ]),
    );
  });
  it('an empty first batch enqueues nothing', async () => {
    const h = harness([[]]);
    expect(await h.runner.run(Sweep, AT)).toMatchObject({
      batches: 1,
      enqueued: 0,
      backlog: false,
    });
    expect(h.enqueueMany).not.toHaveBeenCalled();
  });
  it('the same instant keeps its slot; the next slot changes every jobId', async () => {
    const a = await harness([[org(1)]]).runner.run(Sweep, AT);
    const b = await harness([[org(1)]]).runner.run(
      Sweep,
      new Date(AT.getTime() + SLOT_SEC * 1000),
    );
    expect(b.slot).toBe(a.slot + 1);
  });
  it('a full last batch at maxBatches warns org_sweep_backlog and reports backlog', async () => {
    batch = { size: 2, maxBatches: 2 };
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const h = harness([[org(1), org(2)], [org(3), org(4)], [org(5)]]);
    expect(await h.runner.run(Sweep, AT)).toMatchObject({
      batches: 2,
      enqueued: 4,
      backlog: true,
    });
    expect(
      warn.mock.calls.some(
        ([o]) =>
          typeof o === 'object' &&
          o !== null &&
          'event' in o &&
          o.event === 'org_sweep_backlog',
      ),
    ).toBe(true);
  });
  it('rejects rows that are not strictly ascending after the cursor (Review Focus 2)', async () => {
    await expect(
      harness([[org(2), org(1)]]).runner.run(Sweep, AT),
    ).rejects.toThrow(/strictly ascending/);
    await expect(
      harness([[org(1), org(1)]]).runner.run(Sweep, AT),
    ).rejects.toThrow(/strictly ascending/);
    await expect(
      harness([
        [org(1), org(2)],
        [org(2), org(3)],
      ]).runner.run(Sweep, AT),
    ).rejects.toThrow(/strictly ascending/);
  });
  it('rejects more rows than p_limit (Review Focus 2)', async () => {
    await expect(
      harness([[org(1), org(2), org(3)]]).runner.run(Sweep, AT),
    ).rejects.toThrow(OrgSweepDefinitionError);
  });
  it.each([
    [{ p_after: 'x' }],
    [{ p_limit: 1 }],
    [{ tag: 'x' }],
    [{ p_x: 1.5 }],
    [{ p_x: 2 ** 31 }],
    [{ p_x: Number.NaN }],
    [{ p_x: Number.POSITIVE_INFINITY }],
  ])(
    'rejects extra parameters %j before any SQL (Review Focus 3)',
    async (bad) => {
      params = () => bad;
      const h = harness([[org(1)]]);
      await expect(h.runner.run(Sweep, AT)).rejects.toThrow(
        OrgSweepDefinitionError,
      );
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it('rejects extra parameters that are not 32-bit integers, booleans or strings (Review Focus 3)', async () => {
    // Giả lập config/JS trả một giá trị ngoài kiểu khai báo (Date). `Object.defineProperty` gắn giá trị lúc chạy mà không cần
    // ép kiểu (TS7 khai `Reflect.apply` trả `unknown`, không còn `any` ngầm).
    const fromJs: OrgSweepParams = {};
    Object.defineProperty(fromJs, 'p_when', {
      value: new Date(),
      enumerable: true,
    });
    params = () => fromJs;
    const h = harness([[org(1)]]);
    await expect(h.runner.run(Sweep, AT)).rejects.toThrow(
      /must be a 32-bit integer, a boolean or a string/,
    );
    expect(h.execute).not.toHaveBeenCalled();
  });
  it.each([0, DEFINER_LIMIT_MAX + 1, 1.5])(
    'rejects batch size %s before any SQL',
    async (size) => {
      batch = { size, maxBatches: 1 };
      const h = harness([[org(1)]]);
      await expect(h.runner.run(Sweep, AT)).rejects.toThrow(
        OrgSweepDefinitionError,
      );
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it('refuses to run inside a transaction or an OrgScope, and refuses a def that defineOrgSweep did not create', async () => {
    await expect(
      harness([], { inTx: true }).runner.run(Sweep, AT),
    ).rejects.toThrow(/outside any transaction and OrgScope/);
    await expect(
      harness([], { orgId: org(9) }).runner.run(Sweep, AT),
    ).rejects.toThrow(/outside any transaction and OrgScope/);
    await expect(harness([]).runner.run({ ...Sweep }, AT)).rejects.toThrow(
      /was not created by defineOrgSweep/,
    );
  });
});
