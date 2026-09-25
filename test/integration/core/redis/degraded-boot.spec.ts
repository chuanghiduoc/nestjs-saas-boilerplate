import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import { HealthModule } from '../../../../src/core/health/index.js';
import {
  HttpModule,
  applyHttpDefaults,
} from '../../../../src/core/http/index.js';
import {
  REDIS,
  RedisModule,
  type RedisClient,
} from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

/** Tham số của bộ test: chờ ready ngắn để test nhanh, cộng biên cho thời gian khởi tạo DB/Nest. */
const WAIT_MS = 300;
const INIT_MARGIN_MS = 2_000;
const DEGRADED_WARN = 'redis not ready at startup';
/** Lớn hơn delay tối đa của `retryStrategy` mặc định ioredis 6 (5000 ms + jitter 200 ms). */
const NO_RETRY_WINDOW_MS = 5_500;

/** Cổng TCP vừa được cấp rồi đóng lại: kết nối tới đó bị từ chối (Redis "không tới được"). */
const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || addr === null) {
        reject(new Error('test server has no TCP address'));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });

describe('api boot while Redis is unreachable (degraded)', () => {
  let app: INestApplication | undefined;
  let initMs = 0;
  let degradedWarns = 0;

  const started = (): INestApplication => {
    if (!app) throw new Error('app not started');
    return app;
  };

  beforeAll(async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    vi.stubEnv('APP_ROLE', 'api');
    vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${await closedPort()}`);
    vi.stubEnv('REDIS_COMMAND_TIMEOUT_MS', String(WAIT_MS));
    const t = Date.now();
    app = await createTestApp(
      [
        DatabaseModule.forRoot({ relay: false }),
        RedisModule,
        HttpModule,
        HealthModule.forRoot({ http: true }),
      ],
      { beforeInit: applyHttpDefaults },
    );
    initMs = Date.now() - t;
    // Đếm ngay sau init rồi gỡ spy: lịch sử lời gọi của spy tạo trong beforeAll không còn khi test chạy.
    degradedWarns = warn.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes(DEGRADED_WARN)),
    ).length;
    warn.mockRestore();
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('init resolves after the bounded wait, warns once and leaves no ready listener behind', () => {
    expect(initMs).toBeGreaterThanOrEqual(WAIT_MS);
    expect(initMs).toBeLessThan(WAIT_MS + INIT_MARGIN_MS);
    expect(degradedWarns).toBe(1);
    const redis = started().get<RedisClient>(REDIS);
    expect(redis.status).not.toBe('ready');
    expect(redis.listenerCount('ready')).toBe(0);
  });

  it('live and ready are 200 (api readiness checks the DB only, R21)', async () => {
    const http = request(started().getHttpServer());
    await http.get('/health/live').expect(200);
    const ready = await http.get('/health/ready').expect(200);
    expect(ready.body.status).toBe('ok');
  });

  it('closes cleanly: close resolves and the client stops reconnecting', async () => {
    const redis = started().get<RedisClient>(REDIS);
    const attempts = vi.fn();
    redis.on('connecting', attempts);
    redis.on('reconnecting', attempts);
    await started().close();
    app = undefined;
    // Không còn timer kết nối lại: quá một chu kỳ retry dài nhất mà client không thử lại lần nào.
    await new Promise((r) => setTimeout(r, NO_RETRY_WINDOW_MS));
    redis.off('connecting', attempts);
    redis.off('reconnecting', attempts);
    expect(attempts).not.toHaveBeenCalled();
    expect(redis.status).not.toBe('ready');
  });
});
