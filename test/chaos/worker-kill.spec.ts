import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../src/core/database/index.js';
import { JobQueue, QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { FixtureModule, FixtureRepo } from '../fixtures/fixture.module.js';
import { HoldJob } from '../fixtures/process.jobs.js';
import { createTestApp } from '../support/app-factory.js';
import { baseTestEnv } from '../support/env.js';
import {
  exitCode,
  killIfAlive,
  sendSigterm,
  startWorker,
  waitForMessage,
} from '../support/spawn-worker.js';

/** Tham số của bộ test (không phải config của app). */
const HOLD_MS = 5_000;
const STALLED_MS = 1_000;
const STARTED_WAIT_MS = 30_000;
const REDELIVERY_TIMEOUT_MS = 60_000;

/**
 * Worker đầu bị SIGKILL **sau khi** báo `started` (đang giữ transaction), nên Postgres rollback dòng
 * vừa insert. Worker thứ hai nhận lại job nhờ BullMQ phát hiện job stalled (lock hết hạn vì không ai
 * gia hạn) và commit đúng một lần; `Inbox.once` chặn trường hợp commit hai lần.
 */
describe('worker killed mid-job', () => {
  let producer: INestApplication | undefined;
  const children: ChildProcess[] = [];
  const env = () => ({
    ...baseTestEnv(),
    WORKER_QUEUES: 'fixture',
    WORKER_HEALTH_PORT: '0',
    HEALTH_DRAIN_DELAY_MS: '0',
    QUEUE_STALLED_INTERVAL_MS: String(STALLED_MS),
    QUEUE_LOCK_DURATION_MS: String(STALLED_MS),
  });
  const spawn = async () => {
    const worker = await startWorker(env());
    children.push(worker.child);
    return worker;
  };

  beforeAll(async () => {
    producer = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      FixtureModule,
    ]);
  });
  afterEach(() => {
    // Test lỗi giữa chừng: không để process worker nào còn giữ connection DB/Redis.
    for (const child of children.splice(0)) killIfAlive(child);
  });
  afterAll(async () => {
    await producer?.close();
  });

  it('job is redelivered to a new worker and its effect is committed exactly once', async () => {
    if (!producer) throw new Error('producer not started');
    const body = `kill-${randomUUID()}`;
    const first = await spawn();
    await producer
      .get(JobQueue)
      .enqueue(HoldJob, { eventId: randomUUID(), body, holdMs: HOLD_MS });
    await waitForMessage(
      first.messages,
      (m) => m.started === body,
      STARTED_WAIT_MS,
    );
    const firstExit = exitCode(first.child);
    first.child.kill('SIGKILL');
    await firstExit;
    expect(first.messages.some((m) => m.done === body)).toBe(false);
    // Transaction của worker bị giết đã rollback.
    expect(await producer.get(FixtureRepo).countSystemNotes(body)).toBe(0);

    const second = await spawn();
    await waitForMessage(
      second.messages,
      (m) => m.done === body,
      REDELIVERY_TIMEOUT_MS,
    );
    const secondExit = exitCode(second.child);
    sendSigterm(second.child);
    expect(await secondExit).toBe(0);

    expect(await producer.get(FixtureRepo).countSystemNotes(body)).toBe(1);
  });
});
