import { afterAll, describe, it, vi } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { bootstrapWorker } from '../../../src/main.worker.js';

describe('entrypoints worker (isolated process context)', () => {
  applyTestEnv();
  afterAll(() => vi.unstubAllEnvs());

  // WORKER_QUEUES mặc định (mọi queue đã đăng ký, gồm `events`): boot chỉ qua khi mọi job trên
  // các queue đó có handler (dispatch/deliver từ EventsModule). Relay outbox autostart ở đây, nên
  // test cũng kiểm tra đóng sạch khi relay và worker đang chạy.
  it('worker boots with default queues and closes cleanly', async () => {
    const ctx = await bootstrapWorker();
    await ctx.close();
  });
});
