import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ConfigOf } from '../../src/core/config/index.js';
import { healthConfig } from '../../src/core/health/index.js';
import { authDatabaseConfig } from '../../src/modules/identity/identity.config.js';
import { AUTH_POOL } from '../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { AuthClient } from '../support/auth-client.js';
import {
  startIdentityApp,
  verifyEmailDirect,
} from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

const PASSWORD = 'correct horse battery';
/**
 * Tham số của bộ test (không phải config của app).
 * - Deadline của pool (`DB_AUTH_QUERY_TIMEOUT_MS`, `DB_AUTH_CONNECTION_TIMEOUT_MS`) để MẶC ĐỊNH của app, không hạ
 *   xuống (review M6). Bản trước dùng 1000/500 ms và setup từng flake (sign-up 500 trước khi cắt mạng): trên host dùng
 *   chung đang tải, event loop bị chặn lâu hơn deadline trong lúc một query auth đang bay, timer `query_timeout` chạy ở
 *   pha timers TRƯỚC khi pha poll kịp đọc response đã về, nên query lỗi `Query read timeout` dù DB khoẻ (tái hiện: chặn
 *   event loop 1.3 s ngay sau khi gửi sign-up → 503 ở offset 5/30 ms, 202 từ 60 ms; trước S2-R65 là 500). Mặc định
 *   (6000 ms, trên `statement_timeout` 5000 ms của role test như review M4 đòi) là deadline thật của production; bound
 *   latency đọc lại từ config.
 * - `LATENCY_MARGIN_MS`: phần cộng thêm cho supertest và event loop.
 * - `HUNG_FACTOR`: quá `HUNG_FACTOR` lần bound thì coi là treo (thiếu deadline: query chờ TCP timeout của kernel,
 *   tính bằng phút) để lỗi có tên thay vì hết `testTimeout`.
 */
const LATENCY_MARGIN_MS = 1500;
const HUNG_FACTOR = 3;
const WAIT = { timeout: 30_000, interval: 50 };

type Timed = { res: Response; ms: number };
const timed = async (fn: () => Promise<Response>): Promise<Timed> => {
  const t = performance.now();
  const res = await fn();
  return { res, ms: performance.now() - t };
};

/**
 * S2-R60 / Task 42 B1: DB auth bị blackhole (mất gói, không RST) trên một pool ẤM. Không có deadline phía client,
 * query trên socket đã mở chờ tới TCP timeout của kernel (> 10 s quan sát được ở Task 42), rồi probe S2-R45 chạy lúc
 * mạng đã lành và biến lỗi thành 500. Cần: mọi request (route Better Auth lẫn route Nest) trả 503 problem+json kèm
 * `Retry-After` trong bound, không bao giờ 500 hay treo; mạng lành thì pool tự phục hồi, không client nào kẹt.
 *
 * Proxy TCP trong process (`test/support/tcp-proxy.ts`) thay cho Toxiproxy: `blackhole` bỏ mọi byte theo cả hai
 * chiều trên connection đang mở lẫn connection mới, không đóng socket.
 */
describe('auth DB blackholed on a warm pool (S2-R60)', () => {
  let app: INestApplication;
  let proxy: TcpProxy;
  let base = '';
  /** Đường xấu nhất của một request auth khi DB blackhole, đọc từ config của app (xem `beforeAll`). */
  let boundMs = 0;
  let poolMax = 0;
  const crashes: { kind: string; err: unknown }[] = [];
  const onUncaught = (err: unknown) =>
    crashes.push({ kind: 'uncaughtException', err });
  const onUnhandled = (err: unknown) =>
    crashes.push({ kind: 'unhandledRejection', err });

  const pool = () => app.get<pg.Pool>(AUTH_POOL);
  const ready = () => request(base).get('/health/ready');

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    const { pg: p } = getInfra();
    proxy = await startTcpProxy(p.host, p.port);
    app = await startIdentityApp({
      env: {
        DB_AUTH_HOST: '127.0.0.1',
        DB_AUTH_PORT: String(proxy.port),
      },
    });
    // Lắng nghe thật một lần (review Task 42 Minor 7): supertest trên server chưa listen mở một listener mỗi request.
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const authDb = app.get<ConfigOf<typeof authDatabaseConfig>>(
      authDatabaseConfig.KEY,
    );
    const health = app.get<ConfigOf<typeof healthConfig>>(healthConfig.KEY);
    poolMax = authDb.poolMax;
    // Request: chờ connection + query quá hạn + ROLLBACK quá hạn (transaction), rồi probe S2-R45: chờ connection +
    // `SELECT 1` có hạn HEALTH_CHECK_TIMEOUT_MS. Cùng công thức với luật production `identity-auth-query-deadline`.
    boundMs =
      2 * (authDb.connectionTimeoutMs + authDb.queryTimeoutMs) +
      health.checkTimeoutMs +
      LATENCY_MARGIN_MS;
  });
  afterAll(async () => {
    // Cắt socket trước khi đóng app: nếu deadline hỏng, query treo chỉ nhả client khi socket chết.
    await proxy?.close();
    await app?.close();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    vi.unstubAllEnvs();
  });

  it('Better Auth routes and Nest /v1/me answer 503 within the query deadline, never 500 or a hang; the pool recovers without stuck clients', async () => {
    const email = `bh-${v7()}@example.test`;
    const c = new AuthClient(base);
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    await verifyEmailDirect(email);
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    const p = pool();
    // Làm ấm: đủ connection vật lý, rồi chắc chắn còn client RẢNH đúng lúc cắt mạng (Task 42 review Minor 2). Pool
    // nguội thì mọi query đi đường kết nối mới, `DB_AUTH_CONNECTION_TIMEOUT_MS` trả 503 thay, test xanh mà không
    // chạm lỗi B1.
    await Promise.all(
      Array.from({ length: poolMax }, () =>
        c.request('get', '/api/auth/get-session'),
      ),
    );
    await vi.waitFor(() => expect(p.totalCount - p.idleCount).toBe(0), WAIT);
    expect(p.idleCount).toBeGreaterThan(0);

    proxy.state.blackhole = true;
    try {
      const runs = [
        () => c.request('get', '/v1/me'),
        () => c.request('get', '/api/auth/get-session'),
        () => new AuthClient(base).signIn(email, PASSWORD),
      ];
      const results = await Promise.all(
        runs.map((run) =>
          Promise.race([
            timed(run),
            sleep(boundMs * HUNG_FACTOR).then(() => 'hung' as const),
          ]),
        ),
      );
      for (const [i, t] of results.entries()) {
        expect(t, `blackholed #${i}`).not.toBe('hung');
        if (t === 'hung') continue;
        expect(
          [
            t.res.status,
            t.res.body?.code,
            t.res.headers['content-type']?.includes('application/problem+json'),
            Number(t.res.headers['retry-after']) > 0,
          ],
          `blackholed #${i}`,
        ).toEqual([503, 'service_unavailable', true, true]);
        expect(t.ms, `blackholed #${i} latency`).toBeLessThanOrEqual(boundMs);
      }
    } finally {
      proxy.state.blackhole = false;
    }

    // Phục hồi NGAY khi mạng lành, không chờ readiness trước: client quá hạn đã bị huỷ, nên không lần dùng nào lấy
    // phải client kẹt. (Chờ `/health/ready` trước sẽ che lỗi: probe readiness `release(err)` từng client kẹt nó lấy
    // được, dọn pool hộ — đã thấy khi bỏ việc huỷ client mà test vẫn xanh.) Loạt gấp đôi pool đi qua mọi client rảnh.
    const burst = await Promise.all(
      Array.from({ length: poolMax * 2 }, () =>
        c.request('get', '/api/auth/get-session'),
      ),
    );
    expect(burst.map((b) => b.status)).toEqual(Array(poolMax * 2).fill(200));
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    expect((await new AuthClient(base).signIn(email, PASSWORD)).status).toBe(
      200,
    );
    expect((await ready()).status).toBe(200);
    await vi.waitFor(() => {
      expect(p.waitingCount).toBe(0);
      expect(p.totalCount - p.idleCount).toBe(0);
    }, WAIT);
    expect(p.totalCount).toBeLessThanOrEqual(poolMax);
    expect(crashes).toEqual([]);
  });
});
