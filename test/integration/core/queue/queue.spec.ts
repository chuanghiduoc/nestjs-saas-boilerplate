import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../../../../src/core/context/index.js';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import {
  JobHandler,
  JobPayloadError,
  JobQueue,
  QueueModule,
  WorkerHost,
  defineJob,
  type JobContext,
} from '../../../../src/core/queue/index.js';
import { BullmqJobQueue } from '../../../../src/core/queue/bullmq-job-queue.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  ConcurrentOrgJob,
  FixtureQueue,
  FlakyJob,
  fixtureHandlers,
  OrgJob,
  RecordJob,
  SlowJob,
  seen,
  waitSlowStart,
} from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

/** Handler thật chạy trong OrgScope của job, enqueue job tiếp theo qua `JobQueue` (R28). */
const ChainJob = defineJob({
  name: 'fixture.chain',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string(), crossOrg: z.uuid() }),
});
const chainCrossErrors = new Map<string, unknown>();
@Injectable()
@JobHandler(ChainJob)
class ChainHandler {
  constructor(private readonly queue: JobQueue) {}
  async handle(ctx: JobContext<{ key: string; crossOrg: string }>) {
    chainCrossErrors.set(
      ctx.payload.key,
      await this.queue
        .enqueue(
          OrgJob,
          { key: `${ctx.payload.key}-cross` },
          { meta: { orgId: ctx.payload.crossOrg } },
        )
        .then(
          () => undefined,
          (err: unknown) => err,
        ),
    );
    await this.queue.enqueue(OrgJob, { key: `${ctx.payload.key}-child` });
  }
}
@Module({ providers: [...fixtureHandlers(), ChainHandler] })
class Handlers {}
async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs)
      throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('queue', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'fixture');
    vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '20');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      Handlers,
    ]);
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('delivers payload and meta to the handler', async () => {
    await app
      .get(JobQueue)
      .enqueue(RecordJob, { key: 'k1' }, { meta: { requestId: 'req-9' } });
    await waitFor(() => seen.some((s) => s.key === 'k1'));
    expect(seen.find((s) => s.key === 'k1')).toMatchObject({
      attempt: 1,
      requestId: 'req-9',
    });
  });
  it('dedupes by explicit jobId while the first job is retained', async () => {
    const q = app.get(JobQueue);
    await q.enqueue(RecordJob, { key: 'dup' }, { jobId: 'dup-1' });
    await q.enqueue(RecordJob, { key: 'dup' }, { jobId: 'dup-1' });
    await waitFor(() => seen.some((s) => s.key === 'dup'));
    await app.get(JobQueue).enqueue(RecordJob, { key: 'after-dup' });
    await waitFor(() => seen.some((s) => s.key === 'after-dup'));
    expect(seen.filter((s) => s.key === 'dup')).toHaveLength(1);
  });
  it('enqueues many jobs in one call and returns their ids', async () => {
    const ids = await app.get(JobQueue).enqueueMany([
      { job: RecordJob, payload: { key: 'bulk-1' } },
      { job: RecordJob, payload: { key: 'bulk-2' }, opts: { jobId: 'bulk-2' } },
    ]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe('bulk-2');
    await waitFor(
      () =>
        seen.some((s) => s.key === 'bulk-1') &&
        seen.some((s) => s.key === 'bulk-2'),
    );
  });
  it('retries with backoff until success', async () => {
    await app.get(JobQueue).enqueue(FlakyJob, { key: 'flaky', failTimes: 2 });
    await waitFor(() => seen.some((s) => s.key === 'flaky'));
    expect(seen.find((s) => s.key === 'flaky')!.attempt).toBe(3);
  });
  it('rejects invalid payload at enqueue time', async () => {
    await expect(
      app.get(JobQueue).enqueueDynamic(RecordJob, { key: 1 }),
    ).rejects.toThrow(/payload/i);
  });
  it('fails a stored job with an undecodable payload without retrying', async () => {
    const raw = app.get(BullmqJobQueue).queue(RecordJob.queue.name);
    const added = await raw.add(RecordJob.name, {
      v: 99,
      p: { key: 'bad' },
      meta: {},
    });
    await waitFor(async () => (await added.getState()) === 'failed');
    const failed = await raw.getJob(added.id!);
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.failedReason).toMatch(/unsupported version 99/);
    expect(seen.some((s) => s.key === 'bad')).toBe(false);
  });
  it('job carrying orgId runs inside OrgScope (session variable set)', async () => {
    const org = randomUUID();
    await app
      .get(JobQueue)
      .enqueue(OrgJob, { key: 'org-job' }, { meta: { orgId: org } });
    await waitFor(() => seen.some((s) => s.key === 'org-job'));
    expect(seen.find((s) => s.key === 'org-job')).toMatchObject({
      orgId: org,
      sessionOrg: org,
    });
  });
  describe('org lock: job org = context org, except system (spec §5.4)', () => {
    const inOrg = <T>(org: string, fn: () => Promise<T>) =>
      app.get(RequestContext).run({ orgId: org }, fn);

    it('in org A, enqueue and enqueueMany reject meta.orgId = B before writing to Redis', async () => {
      const [orgA, orgB] = [randomUUID(), randomUUID()];
      const q = app.get(JobQueue);
      const raw = app.get(BullmqJobQueue).queue(OrgJob.queue.name);
      await expect(
        inOrg(orgA, () =>
          q.enqueue(
            OrgJob,
            { key: 'lock-cross' },
            { jobId: 'lock-cross', meta: { orgId: orgB } },
          ),
        ),
      ).rejects.toThrow(JobPayloadError);
      await expect(
        inOrg(orgA, () =>
          q.enqueueMany([
            {
              job: OrgJob,
              payload: { key: 'lock-cross-bulk' },
              opts: { jobId: 'lock-cross-bulk', meta: { orgId: orgB } },
            },
          ]),
        ),
      ).rejects.toThrow(/does not match the context org/);
      expect(await raw.getJob('lock-cross')).toBeUndefined();
      expect(await raw.getJob('lock-cross-bulk')).toBeUndefined();
    });
    it('in org A, a job with meta.orgId A (any case), absent or undefined runs in org A', async () => {
      const orgA = randomUUID();
      const cases = [
        { key: 'lock-same', meta: { orgId: orgA.toUpperCase() } },
        { key: 'lock-absent', meta: {} },
        { key: 'lock-undefined', meta: { orgId: undefined } },
      ];
      await inOrg(orgA, async () => {
        for (const c of cases)
          await app
            .get(JobQueue)
            .enqueue(OrgJob, { key: c.key }, { meta: c.meta });
      });
      await waitFor(() =>
        cases.every((c) => seen.some((s) => s.key === c.key)),
      );
      for (const c of cases)
        expect(seen.find((s) => s.key === c.key)).toMatchObject({
          orgId: orgA,
          sessionOrg: orgA,
        });
    });
    it('a handler running in org A enqueues its follow-up job in org A and cannot enqueue into org B', async () => {
      const [orgA, orgB] = [randomUUID(), randomUUID()];
      await app
        .get(JobQueue)
        .enqueue(
          ChainJob,
          { key: 'chain', crossOrg: orgB },
          { meta: { orgId: orgA } },
        );
      await waitFor(() => seen.some((s) => s.key === 'chain-child'));
      expect(seen.find((s) => s.key === 'chain-child')).toMatchObject({
        orgId: orgA,
        sessionOrg: orgA,
      });
      expect(chainCrossErrors.get('chain')).toBeInstanceOf(JobPayloadError);
      expect(seen.some((s) => s.key === 'chain-cross')).toBe(false);
    });
    it('outside any org (system), meta.orgId routes the job to that org', async () => {
      const org = randomUUID();
      await app.get(JobQueue).enqueueMany([
        {
          job: OrgJob,
          payload: { key: 'lock-system' },
          opts: { meta: { orgId: org } },
        },
      ]);
      await waitFor(() => seen.some((s) => s.key === 'lock-system'));
      expect(seen.find((s) => s.key === 'lock-system')).toMatchObject({
        orgId: org,
        sessionOrg: org,
      });
    });
  });
  it('concurrent jobs each see their own org and request context', async () => {
    const jobs = [randomUUID(), randomUUID()].map((org, i) => ({
      key: `conc-${i}`,
      org,
      requestId: `req-conc-${i}`,
    }));
    await app.get(JobQueue).enqueueMany(
      jobs.map((j) => ({
        job: ConcurrentOrgJob,
        payload: { key: j.key, group: 'conc', size: jobs.length },
        opts: { meta: { orgId: j.org, requestId: j.requestId } },
      })),
    );
    await waitFor(() => jobs.every((j) => seen.some((s) => s.key === j.key)));
    for (const j of jobs)
      expect(seen.find((s) => s.key === j.key)).toMatchObject({
        orgId: j.org,
        sessionOrg: j.org,
        requestId: j.requestId,
      });
  });
  it('closeAll waits for the in-flight job', async () => {
    const started = waitSlowStart('slow');
    await app.get(JobQueue).enqueue(SlowJob, { key: 'slow', ms: 500 });
    await started;
    await app.get(WorkerHost).closeAll();
    expect(seen.some((s) => s.key === 'slow')).toBe(true);
  });
});
