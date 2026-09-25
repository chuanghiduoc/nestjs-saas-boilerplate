import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import {
  JobQueue,
  QueueModule,
  WorkerHost,
} from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  HangHandler,
  HangJob,
  seen,
  waitSlowStart,
} from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

const SHUTDOWN_TIMEOUT_MS = 300;

@Module({ providers: [HangHandler] })
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

  it('aborts the signal of a job still running when the timeout expires', async () => {
    const started = waitSlowStart('hang');
    await app.get(JobQueue).enqueue(HangJob, { key: 'hang' });
    await started;
    const t0 = Date.now();
    await app.get(WorkerHost).closeAll();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS - 20);
    expect(seen.find((s) => s.key === 'hang')).toMatchObject({
      aborted: true,
    });
  });
});
