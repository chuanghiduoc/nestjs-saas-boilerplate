import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import {
  Draining,
  HealthModule,
  Readiness,
} from '../../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import {
  REDIS,
  RedisModule,
  type RedisClient,
} from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const LEAKY_ERROR = 'connect ECONNREFUSED redis://:s3cret@10.0.0.9:6379';
const CHECK_TIMEOUT_MS = 200;
const DRAIN_DELAY_MS = 1_500;

const createHealthApp = () =>
  createTestApp(
    [
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      HttpModule,
      HealthModule.forRoot({ http: true }),
    ],
    { beforeInit: applyHttpDefaults },
  );

describe('health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', '2');
    vi.stubEnv('HEALTH_CHECK_TIMEOUT_MS', String(CHECK_TIMEOUT_MS));
    app = await createHealthApp();
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('live is 200; ready is 200 when DB and Redis are up; neither is rate limited', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).get('/health/live').expect(200);
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    }
  });

  it('ready is 503 problem+json without connection details when a dependency fails', async () => {
    const redis = app.get<RedisClient>(REDIS);
    const ping = vi
      .spyOn(redis, 'ping')
      .mockRejectedValueOnce(new Error(LEAKY_ERROR));
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    ping.mockRestore();
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('service_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/s3cret|10\.0\.0\.9|ECONN/);
  });

  it('ready is 503 when a check exceeds HEALTH_CHECK_TIMEOUT_MS', async () => {
    const redis = app.get<RedisClient>(REDIS);
    const ping = vi
      .spyOn(redis, 'ping')
      .mockReturnValueOnce(new Promise<'PONG'>(() => {}));
    const t0 = Date.now();
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    ping.mockRestore();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(CHECK_TIMEOUT_MS - 20);
  });

  it('ready turns 503 service_unavailable while draining, live stays 200', async () => {
    app.get(Draining).start();
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(res.body.code).toBe('service_unavailable');
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});

describe('health during api shutdown', () => {
  afterAll(() => vi.unstubAllEnvs());

  it('flips ready to 503 first and waits HEALTH_DRAIN_DELAY_MS while DB, Redis and HTTP still serve', async () => {
    vi.stubEnv('HEALTH_DRAIN_DELAY_MS', String(DRAIN_DELAY_MS));
    const app = await createHealthApp();
    const server = request(app.getHttpServer());
    const t0 = Date.now();
    const closing = app.close();
    await vi.waitFor(() => expect(app.get(Draining).isDraining()).toBe(true));
    await server.get('/health/ready').expect(503);
    await server.get('/health/live').expect(200);
    // DB và Redis chỉ đóng ở onApplicationShutdown, sau khi hết thời gian chờ.
    const results = await Promise.all(
      app
        .get(Readiness)
        .indicators()
        .map((check) => check()),
    );
    expect(results).toEqual([
      { database: expect.objectContaining({ status: 'up' }) },
      { redis: expect.objectContaining({ status: 'up' }) },
    ]);
    await closing;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DRAIN_DELAY_MS - 20);
  });
});
