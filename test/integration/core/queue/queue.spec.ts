import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import {
  JobQueue,
  QueueModule,
  WorkerHost,
} from '../../../../src/core/queue/index.js';
import { BullmqJobQueue } from '../../../../src/core/queue/bullmq-job-queue.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  ConcurrentOrgJob,
  FlakyJob,
  fixtureHandlers,
  OrgJob,
  RecordJob,
  SlowJob,
  seen,
  waitSlowStart,
} from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

@Module({ providers: fixtureHandlers() })
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
