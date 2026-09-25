import { afterAll, describe, it, vi } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { bootstrapWorker } from '../../../src/main.worker.js';

describe('entrypoints worker (isolated process context)', () => {
  applyTestEnv();
  // Handler của `core.event.dispatch` (queue `events`) đến từ EventsModule ở Task 10; tới lúc đó
  // worker consume queue `events` sẽ fail boot đúng thiết kế (WorkerHost.assertHandlersFor).
  // Relay outbox vẫn autostart ở đây, nên test cũng kiểm tra đóng sạch khi relay đang chạy.
  vi.stubEnv('WORKER_QUEUES', 'maintenance');
  afterAll(() => vi.unstubAllEnvs());

  it('worker boots and closes cleanly', async () => {
    const ctx = await bootstrapWorker();
    await ctx.close();
  });
});
