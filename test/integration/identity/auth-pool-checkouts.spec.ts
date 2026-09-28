import { Module, type INestApplication } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../src/core/config/index.js';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { openAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import {
  AUTH_POOL,
  AuthPoolLifecycle,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { applyTestEnv, createTestApp } from '../../support/app-factory.js';

@Module({ providers: [...authPoolProviders] })
class M {}

/**
 * Tham số của spec: `HTTP_REQUEST_BUDGET_MS` nhỏ để bộ thu hồi chạy nhanh; `DB_AUTH_CONNECTION_TIMEOUT_MS` xa hơn nhiều
 * để người chờ slot thứ hai chỉ lấy được slot nhờ bộ thu hồi (thiếu nó thì chờ hết hạn kết nối và bị từ chối).
 */
const REQUEST_BUDGET_MS = 1000;
const CONNECTION_TIMEOUT_MS = 5000;
const LATENCY_MARGIN_MS = 1000;
/** Timer của Node có thể nổ sớm vài ms so với mốc đo bằng `performance.now()`. */
const TIMER_SLACK_MS = 50;
const SHUTDOWN_TIMEOUT_MS = 600;
const SHUTDOWN_RESERVE_MS = 200;

/**
 * S2-R60 round 6 (parity với pool core của api): pool `auth_user` có bộ thu hồi checkout giữ quá `HTTP_REQUEST_BUDGET_MS`
 * (kysely không trả slot khi BEGIN lỗi hay ROLLBACK quá hạn) và tắt máy trả các checkout bị bỏ rơi để `pool.end()` xong.
 */
describe('auth_user pool: checkout reaper and shutdown release', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it('a checkout held past HTTP_REQUEST_BUDGET_MS is reaped: the slot comes back, the late release is harmless', async () => {
    vi.stubEnv('DB_AUTH_POOL_MAX', '1');
    vi.stubEnv('HTTP_REQUEST_BUDGET_MS', String(REQUEST_BUDGET_MS));
    vi.stubEnv('DB_AUTH_CONNECTION_TIMEOUT_MS', String(CONNECTION_TIMEOUT_MS));
    app = await createTestApp([M]);
    const pool = app.get<pg.Pool>(AUTH_POOL);
    // Checkout bị bỏ rơi: người mượn không bao giờ trả (như kysely sau BEGIN lỗi).
    const abandoned = await pool.connect();
    const started = performance.now();
    const next = await pool.connect();
    try {
      const waitedMs = performance.now() - started;
      expect(waitedMs).toBeGreaterThanOrEqual(
        REQUEST_BUDGET_MS - TIMER_SLACK_MS,
      );
      expect(waitedMs).toBeLessThan(REQUEST_BUDGET_MS + LATENCY_MARGIN_MS);
      await expect(next.query('SELECT 1 AS ok')).resolves.toMatchObject({
        rows: [{ ok: 1 }],
      });
      // Lần trả muộn của người giữ là no-op (không ném "Release called on client which has already been released").
      expect(() => abandoned.release()).not.toThrow();
    } finally {
      next.release();
    }
  });

  it('shutdown: a checkout still held after the drain is released at APP_SHUTDOWN_TIMEOUT_MS - APP_SHUTDOWN_RESERVE_MS, so pool.end() completes', async () => {
    applyTestEnv();
    // Không có hạn giữ checkout: chỉ việc trả lúc tắt máy mới cứu được `pool.end()`.
    const handle = openAuthPool(authDatabaseConfig(), databaseConfig());
    const lifecycle = new AuthPoolLifecycle(handle, {
      ...appConfig(),
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      shutdownReserveMs: SHUTDOWN_RESERVE_MS,
    });
    await handle.pool.connect();
    expect(handle.checkouts.size).toBe(1);
    const started = performance.now();
    lifecycle.onModuleDestroy();
    let closed: 'closed' | 'hung';
    try {
      closed = await Promise.race([
        lifecycle.onApplicationShutdown().then(() => 'closed' as const),
        sleep(SHUTDOWN_TIMEOUT_MS + LATENCY_MARGIN_MS).then(
          () => 'hung' as const,
        ),
      ]);
    } finally {
      // Hung (regression): still free the slot so the pending `pool.end()` finishes and nothing leaks.
      handle.checkouts.releaseAll('test cleanup');
    }
    expect(closed).toBe('closed');
    expect(handle.checkouts.size).toBe(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      SHUTDOWN_TIMEOUT_MS - SHUTDOWN_RESERVE_MS - TIMER_SLACK_MS,
    );
  });
});
