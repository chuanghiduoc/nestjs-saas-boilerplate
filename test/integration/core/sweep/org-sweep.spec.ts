import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { DatabaseModule, Db } from '../../../../src/core/database/index.js';
import { BullmqJobQueue } from '../../../../src/core/queue/bullmq-job-queue.js';
import {
  JobHandler,
  JobQueue,
  QueueModule,
  defineJob,
  defineQueue,
  type JobContext,
} from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  DEFINER_LIMIT_MAX,
  OrgSweepDefinitionError,
  OrgSweepRunner,
  SweepModule,
  defineOrgSweep,
  sweepJobId,
  type OrgSweepBatch,
} from '../../../../src/core/sweep/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { inOrgTx, withAppClient } from '../../../support/tenancy-seed.js';

const SweepQueue = defineQueue('sweep-fixture', { kind: 'io' });
const FixtureSweepOrgJob = defineJob({
  name: 'fixture.sweep-org',
  queue: SweepQueue,
  version: 1,
  schema: z.object({}),
});
/** Tuổi tối thiểu của dòng đến hạn (C-8b: tham số thêm theo tên, kiểu integer). */
const MIN_AGE_SEC = 3600;
const DUE_AGE_SEC = 7200;
const FRESH_AGE_SEC = 600;
// Cron `*/5 * * * *` UTC → slot 300 s.
const SLOT_MS = 300_000;
let tag = '';
let batch: OrgSweepBatch = { size: 2, maxBatches: 10 };
/** Khai báo theo thứ tự NGƯỢC với chữ ký hàm SQL (p_min_age_sec, p_tag): ký hiệu theo tên nên không quan trọng (C-8b). */
const FixtureSweep = defineOrgSweep({
  key: 'fixture.sweep-orgs',
  definerFunction: 'fixture_orgs_due',
  extraParams: () => ({ p_tag: tag, p_min_age_sec: MIN_AGE_SEC }),
  orgJob: FixtureSweepOrgJob,
  jobIdPrefix: 'fixture-sweep',
  schedule: () => ({ cron: '*/5 * * * *', tz: 'UTC' }),
  batch: () => batch,
});

const handled: { orgId: string | undefined; jobId: string }[] = [];
const failing = new Set<string>();
@Injectable()
@JobHandler(FixtureSweepOrgJob)
class OrgJobHandler {
  async handle(ctx: JobContext<unknown>) {
    handled.push({ orgId: ctx.meta.orgId, jobId: ctx.jobId });
    if (ctx.meta.orgId && failing.has(ctx.meta.orgId))
      throw new Error('org job failed');
  }
}
@Module({ providers: [OrgJobHandler] })
class Handlers {}

const until = async (pred: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};
/** Seed dòng đến hạn cho từng org (app_user trong OrgScope của org đó), trả org theo thứ tự tăng dần. */
async function seed(count: number, ageSec: number): Promise<string[]> {
  const orgs = Array.from({ length: count }, () => v7()).sort();
  for (const org of orgs)
    await withAppClient((c) =>
      inOrgTx(c, org, () =>
        c.query(
          `INSERT INTO fixture_sweep_items (org_id, tag, due_at) VALUES ($1, $2, now() - make_interval(secs => $3))`,
          [org, tag, ageSec],
        ),
      ),
    );
  return orgs;
}

describe('defineOrgSweep + OrgSweepRunner on the real definer, JobQueue and worker (spec SP6 §5.3, C-8, C-8b)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Như mọi test `runWorkers: true` (queue.spec.ts, worker-org-gate.spec.ts, scheduler.spec.ts): process worker thật.
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'sweep-fixture');
    vi.stubEnv('QUEUE_DEFAULT_ATTEMPTS', '1');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      SweepModule,
      Handlers,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    batch = { size: 2, maxBatches: 10 };
    failing.clear();
    vi.restoreAllMocks();
  });
  const runner = () => app.get(OrgSweepRunner);
  const jobsOf = async (orgs: string[]) => {
    const all = await app
      .get(BullmqJobQueue)
      .queue('sweep-fixture')
      .getJobs(['completed', 'failed', 'waiting', 'active', 'delayed']);
    return all
      .filter((j) => orgs.some((o) => j.id?.includes(o)))
      .map((j) => j.id ?? '')
      .sort();
  };
  const handledFor = (orgs: string[]) =>
    handled.filter((h) => h.orgId && orgs.includes(h.orgId));

  it('walks 3 × size + 1 orgs in four keyset batches and enqueues exactly one job per org', async () => {
    tag = `c8-${v7()}`;
    const orgs = await seed(3 * batch.size + 1, DUE_AGE_SEC);
    const at = new Date();
    const res = await runner().run(FixtureSweep, at);
    expect(res).toMatchObject({
      batches: 4,
      enqueued: orgs.length,
      backlog: false,
    });
    await until(() => handledFor(orgs).length === orgs.length);
    expect(
      handledFor(orgs)
        .map((h) => h.jobId)
        .sort(),
    ).toEqual(orgs.map((o) => sweepJobId(FixtureSweep, o, res.slot)).sort());
  });
  it('the same slot adds no job; the next slot adds one per org', async () => {
    tag = `c8-${v7()}`;
    const orgs = await seed(3, DUE_AGE_SEC);
    const at = new Date();
    await runner().run(FixtureSweep, at);
    await runner().run(FixtureSweep, at);
    expect(await jobsOf(orgs)).toHaveLength(orgs.length);
    await runner().run(FixtureSweep, new Date(at.getTime() + SLOT_MS));
    expect(await jobsOf(orgs)).toHaveLength(orgs.length * 2);
    await until(() => handledFor(orgs).length === orgs.length * 2);
  });
  it('a failed org job blocks that org only until the next slot', async () => {
    tag = `c8-${v7()}`;
    const [bad] = await seed(1, DUE_AGE_SEC);
    if (!bad) throw new Error('seed failed');
    failing.add(bad);
    const at = new Date();
    await runner().run(FixtureSweep, at);
    await until(() => handledFor([bad]).length === 1);
    const failedJob = () =>
      app
        .get(BullmqJobQueue)
        .queue('sweep-fixture')
        .getJob(
          sweepJobId(FixtureSweep, bad, Math.floor(at.getTime() / SLOT_MS)),
        );
    await until(async () => (await (await failedJob())?.isFailed()) === true);
    await runner().run(FixtureSweep, at);
    expect(await jobsOf([bad])).toHaveLength(1);
    await runner().run(FixtureSweep, new Date(at.getTime() + SLOT_MS));
    await until(() => handledFor([bad]).length === 2);
  });
  it('a full last batch at maxBatches reports backlog', async () => {
    tag = `c8-${v7()}`;
    await seed(3 * batch.size + 1, DUE_AGE_SEC);
    batch = { size: 2, maxBatches: 2 };
    expect(await runner().run(FixtureSweep, new Date())).toMatchObject({
      batches: 2,
      enqueued: 4,
      backlog: true,
    });
  });
  it('Redis failing mid-run makes the sweep throw; the retry in the same slot creates no duplicate', async () => {
    tag = `c8-${v7()}`;
    const orgs = await seed(3 * batch.size + 1, DUE_AGE_SEC);
    const queue = app.get(JobQueue);
    const real = queue.enqueueMany.bind(queue);
    let calls = 0;
    const spy = vi
      .spyOn(queue, 'enqueueMany')
      .mockImplementation(async (items) => {
        calls++;
        if (calls === 2) throw new Error('redis down');
        return real(items);
      });
    const at = new Date();
    await expect(runner().run(FixtureSweep, at)).rejects.toThrow('redis down');
    spy.mockRestore();
    await runner().run(FixtureSweep, at);
    expect(await jobsOf(orgs)).toHaveLength(orgs.length);
    await until(() => handledFor(orgs).length === orgs.length);
    expect(new Set(handledFor(orgs).map((h) => h.orgId)).size).toBe(
      orgs.length,
    );
  });
  it('named extra parameters reach the real definer: rows younger than p_min_age_sec are not due (C-8b)', async () => {
    tag = `c8b-${v7()}`;
    const due = await seed(2, DUE_AGE_SEC);
    const fresh = await seed(2, FRESH_AGE_SEC);
    const res = await runner().run(FixtureSweep, new Date());
    expect(res.enqueued).toBe(due.length);
    expect(await jobsOf(fresh)).toEqual([]);
  });
  it('the SQL function refuses p_limit above DEFINER_LIMIT_MAX; the runner refuses it before calling', async () => {
    await expect(
      app
        .get(Db)
        .execute(
          `SELECT org_id FROM public.fixture_orgs_due(p_after => ?::uuid, p_limit => ?::integer, p_min_age_sec => 0, p_tag => 'x')`,
          [v7(), DEFINER_LIMIT_MAX + 1],
        ),
    ).rejects.toThrow(/p_limit must be between 1 and 1000/);
    batch = { size: DEFINER_LIMIT_MAX + 1, maxBatches: 1 };
    await expect(runner().run(FixtureSweep, new Date())).rejects.toBeInstanceOf(
      OrgSweepDefinitionError,
    );
  });
});
