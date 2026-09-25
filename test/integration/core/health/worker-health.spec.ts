import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import {
  Draining,
  HealthModule,
  WorkerHealthServer,
} from '../../../../src/core/health/index.js';
import {
  REDIS,
  RedisModule,
  type RedisClient,
} from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const LEAKY_ERROR = 'connect ECONNREFUSED redis://:s3cret@10.0.0.9:6379';

describe('worker health server (node:http)', () => {
  let app: INestApplication;
  let base: string;
  let closed = false;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_HEALTH_PORT', '0');
    vi.stubEnv('WORKER_HEALTH_HOST', '127.0.0.1');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      HealthModule.forRoot({ http: false }),
    ]);
    const { address, port } = app.get(WorkerHealthServer).address();
    base = `http://${address}:${port}`;
  });
  afterAll(async () => {
    if (!closed) await app.close();
    vi.unstubAllEnvs();
  });

  it('serves live and ready (200) with DB and Redis up; unknown paths are 404', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ok' });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('ready is 503 {status:error} without error details when a dependency fails', async () => {
    const ping = vi
      .spyOn(app.get<RedisClient>(REDIS), 'ping')
      .mockRejectedValueOnce(new Error(LEAKY_ERROR));
    const res = await fetch(`${base}/health/ready`);
    ping.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });
  });

  it('ready is 503 while draining; live stays 200', async () => {
    app.get(Draining).start();
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });

  it('stops listening when the app closes', async () => {
    await app.close();
    closed = true;
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  });
});
