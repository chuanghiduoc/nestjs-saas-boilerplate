import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import { JobQueue, QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  FixtureModule,
  FixtureRepo,
} from '../../../fixtures/fixture.module.js';
import { HoldJob } from '../../../fixtures/process.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';
import { baseTestEnv } from '../../../support/env.js';
import {
  exitCode,
  killIfAlive,
  sendSigterm,
  startWorker,
  waitForMessage,
} from '../../../support/spawn-worker.js';

const HOLD_MS = 2_000;
const STARTED_WAIT_MS = 30_000;

/**
 * Linux/macOS (CI): SIGTERM thật qua `kill`. Windows: SIGTERM được phát lại trong process con qua
 * IPC (`process.emit`), vì Windows không giao signal POSIX cho handler; xem spawn-worker.ts.
 */
describe('worker receives a real SIGTERM mid-job', () => {
  let producer: INestApplication;
  let child: ChildProcess | undefined;
  beforeAll(async () => {
    producer = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      FixtureModule,
    ]);
  });
  afterEach(() => {
    killIfAlive(child);
    child = undefined;
  });
  afterAll(async () => {
    await producer.close();
  });

  it('finishes the in-flight job, commits once, then exits 0', async () => {
    const body = `sigterm-${randomUUID()}`;
    const worker = await startWorker({
      ...baseTestEnv(),
      WORKER_QUEUES: 'fixture',
      WORKER_HEALTH_PORT: '0',
      HEALTH_DRAIN_DELAY_MS: '0',
    });
    child = worker.child;
    await producer
      .get(JobQueue)
      .enqueue(HoldJob, { eventId: randomUUID(), body, holdMs: HOLD_MS });
    await waitForMessage(
      worker.messages,
      (m) => m.started === body,
      STARTED_WAIT_MS,
    );
    const exited = exitCode(child);
    sendSigterm(child);
    expect(await exited).toBe(0);
    expect(worker.messages.some((m) => m.done === body)).toBe(true);
    expect(await producer.get(FixtureRepo).countSystemNotes(body)).toBe(1);
  });
});
