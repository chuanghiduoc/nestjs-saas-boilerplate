import { Agent, get, type IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  DatabaseModule,
  DbStatementTimeoutCheck,
} from '../../../src/core/database/index.js';
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

const LEAKY_ERROR =
  'connect ECONNREFUSED postgres://app:s3cret@10.0.0.9:5432/app';
const CHECK_TIMEOUT_MS = 200;
const DRAIN_DELAY_MS = 1_500;
/** Sau drain delay, đóng HTTP/DB/Redis phải xong nhanh; keep-alive không được kéo dài tới hạn chót. */
const CLOSE_MARGIN_MS = 2_000;

const listeningPort = (app: INestApplication): number => {
  const addr: unknown = app.getHttpServer().address();
  if (
    typeof addr !== 'object' ||
    addr === null ||
    !('port' in addr) ||
    typeof addr.port !== 'number'
  )
    throw new Error('api test server is not listening on a TCP port');
  return addr.port;
};

/** GET qua agent keep-alive: dùng lại cùng socket như client có connection pool. */
const getKeepAlive = (agent: Agent, port: number, path: string) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders }>(
    (resolve, reject) => {
      get({ host: '127.0.0.1', port, path, agent }, (res) => {
        res.resume();
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers }),
        );
      }).on('error', reject);
    },
  );

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

  it('ready is 503 problem+json without connection details when the DB fails, logged once at warn', async () => {
    // Final review M1: probe `database` chạy trên client riêng (không qua `Db`), nên giả lỗi ở chính check.
    const execute = vi
      .spyOn(app.get(DbStatementTimeoutCheck), 'run')
      .mockRejectedValueOnce(new Error(LEAKY_ERROR));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    const warnCalls = warn.mock.calls.length;
    const errorCalls = error.mock.calls.length;
    execute.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('service_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/s3cret|10\.0\.0\.9|ECONN/);
    expect(warnCalls).toBe(1);
    expect(errorCalls).toBe(0);
  });

  it('ready is 503 when a check exceeds HEALTH_CHECK_TIMEOUT_MS', async () => {
    const execute = vi
      .spyOn(app.get(DbStatementTimeoutCheck), 'run')
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const t0 = Date.now();
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    execute.mockRestore();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(CHECK_TIMEOUT_MS - 20);
  });

  it('api readiness does not gate on Redis (ruling R21): Redis down keeps ready 200', async () => {
    const ping = vi
      .spyOn(app.get<RedisClient>(REDIS), 'ping')
      .mockRejectedValue(new Error(LEAKY_ERROR));
    const res = await request(app.getHttpServer()).get('/health/ready');
    ping.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.details).toEqual({
      database: expect.objectContaining({ status: 'up' }),
    });
  });

  it('ready turns 503 service_unavailable while draining, live stays 200; one warn line, no error', async () => {
    app.get(Draining).start();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    const warnCalls = warn.mock.calls.length;
    const errorCalls = error.mock.calls.length;
    warn.mockRestore();
    error.mockRestore();
    expect(warnCalls).toBe(1);
    expect(errorCalls).toBe(0);
    expect(res.body.code).toBe('service_unavailable');
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});

describe('health during api shutdown', () => {
  afterAll(() => vi.unstubAllEnvs());

  it('flips ready to 503 first and waits HEALTH_DRAIN_DELAY_MS while DB and HTTP still serve', async () => {
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
    ]);
    await closing;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DRAIN_DELAY_MS - 20);
  });

  it('a keep-alive client connected before shutdown gets Connection: close and does not hold close() past the drain delay', async () => {
    vi.stubEnv('HEALTH_DRAIN_DELAY_MS', String(DRAIN_DELAY_MS));
    const app = await createHealthApp();
    await app.listen(0, '127.0.0.1');
    const port = listeningPort(app);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const before = await getKeepAlive(agent, port, '/health/live');
      expect(before.headers.connection).toBe('keep-alive');
      const t0 = Date.now();
      const closing = app.close();
      await vi.waitFor(() => expect(app.get(Draining).isDraining()).toBe(true));
      const during = await getKeepAlive(agent, port, '/health/live');
      expect(during.status).toBe(200);
      expect(during.headers.connection).toBe('close');
      await closing;
      expect(Date.now() - t0).toBeLessThan(DRAIN_DELAY_MS + CLOSE_MARGIN_MS);
    } finally {
      agent.destroy();
    }
  });
});
