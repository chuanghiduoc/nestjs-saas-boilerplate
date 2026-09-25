import { afterAll, describe, it, vi } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { bootstrapWorker } from '../../../src/main.worker.js';

describe('entrypoints worker (isolated process context)', () => {
  applyTestEnv();
  afterAll(() => vi.unstubAllEnvs());

  it('worker boots and closes cleanly', async () => {
    const ctx = await bootstrapWorker();
    await ctx.close();
  });
});
