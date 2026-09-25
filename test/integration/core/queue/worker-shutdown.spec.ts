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
  BatchJob,
  fixtureHandlers,
  FixtureQueue,
  HangJob,
  seen,
  waitSlowStart,
} from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

const SHUTDOWN_TIMEOUT_MS = 300;
/** Đủ dài để job batch chắc chắn còn chạy khi hết hạn chờ tắt. */
const BATCH_STEPS = 1000;

@Module({ providers: fixtureHandlers() })
class Handlers {}

describe('worker shutdown timeout', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'fixture');
    vi.stubEnv('QUEUE_SHUTDOWN_TIMEOUT_MS', String(SHUTDOWN_TIMEOUT_MS));
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

  it('aborts jobs still running at the timeout and keeps them for retry, never completed', async () => {
    const q = app.get(JobQueue);
    const hangStarted = waitSlowStart('hang');
    const hangId = await q.enqueue(HangJob, { key: 'hang' });
    await hangStarted;
    const batchStarted = waitSlowStart('batch');
    const batchId = await q.enqueue(BatchJob, {
      key: 'batch',
      steps: BATCH_STEPS,
    });
    await batchStarted;

    const t0 = Date.now();
    await app.get(WorkerHost).closeAll();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS - 20);

    // Handler throws on abort (hang) and handler returns normally after abort (batch).
    expect(seen.find((s) => s.key === 'hang')).toMatchObject({ aborted: true });
    expect(seen.find((s) => s.key === 'batch')).toMatchObject({
      aborted: true,
    });
    const raw = app.get(BullmqJobQueue).queue(FixtureQueue.name);
    for (const id of [hangId, batchId]) {
      const job = await raw.getJob(id);
      expect(await job?.getState()).toMatch(/^(delayed|wait)$/);
      expect(job?.attemptsMade).toBe(1);
      expect(job?.failedReason).toMatch(/abort/i);
    }
  });
});
