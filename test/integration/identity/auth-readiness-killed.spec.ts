import { Module, type INestApplication } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUTH_POOL,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { AuthDatabaseReadiness } from '../../../src/modules/identity/infra/better-auth/auth-readiness.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../support/tcp-proxy.js';

@Module({ providers: [...authPoolProviders, AuthDatabaseReadiness] })
class M {}

/** Hạn probe rộng để chính lần kill/reset (không phải timeout) làm probe fail. */
const CHECK_TIMEOUT_MS = 20_000;
/** Query chậm thay cho `SELECT 1` để kill được giữa chừng; dài hơn nhiều thời gian test cần. */
const SLOW_PROBE_SQL = 'SELECT pg_sleep(30)';
/** Chờ thêm sau khi client bị loại để `'error'` đến muộn của socket (nếu có) kịp phát. */
const TRAILING_EVENTS_MS = 300;
const IN_FLIGHT_WAIT_MS = 5000;

/**
 * Review fix round 2: probe checkout client bằng `pool.connect()`, nên pg-pool không gắn listener `'error'`
 * tạm như `Pool.query()` làm. Socket chết khi query còn chạy thì pg (client.js, handler `'end'`) reject
 * query VÀ phát `'error'` đồng bộ trên client, trước khi `catch`/`release` của probe kịp chạy; không có
 * listener là uncaught exception, sập process.
 *
 * - `pg_terminate_backend` qua PgBouncer (đường production): Postgres gửi FATAL trước nên query thường
 *   settle và `release()` gắn lại listener của pool trước khi socket đóng — là một race, không tái hiện
 *   chắc chắn. Giữ làm test hồi quy của đường thật.
 * - Reset socket giữa query (proxy TCP, không có ErrorResponse trước): tái hiện chắc chắn lỗi trên.
 */
describe('auth_database probe: connection killed while the probe query is in flight', () => {
  /** Chạy `kill` khi probe đang chờ query; khẳng định probe fail, không uncaught, pool dùng lại được. */
  async function expectProbeFailsCleanly(
    app: INestApplication,
    kill: () => Promise<void>,
    failure: RegExp,
  ): Promise<void> {
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const probe = app.get(AuthDatabaseReadiness);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const probing = probe.probe();
      probing.catch(() => undefined);
      await kill();
      await expect(probing).rejects.toThrow(failure);
      await vi.waitFor(() => expect(pool.totalCount).toBe(0));
      await sleep(TRAILING_EVENTS_MS);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    await expect(probe.probe()).resolves.toBeUndefined();
    await expect(pool.query('SELECT 1 AS ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  }

  describe('backend terminated through PgBouncer', () => {
    let app: INestApplication;
    let killer: pg.Client;
    beforeAll(async () => {
      const { pg: p } = getInfra();
      vi.stubEnv('HEALTH_CHECK_TIMEOUT_MS', String(CHECK_TIMEOUT_MS));
      app = await createTestApp([M]);
      // Một role được signal backend của chính nó; app_owner thì không (xem auth-pool-idle-error.spec.ts).
      killer = new pg.Client({
        host: p.host,
        port: p.port,
        database: p.database,
        ...p.auth,
      });
      await killer.connect();
    });
    afterAll(async () => {
      await killer?.end();
      await app?.close();
      vi.unstubAllEnvs();
    });

    it('pg_terminate_backend mid-probe fails the probe without an uncaught exception', async () => {
      const pool = app.get<pg.Pool>(AUTH_POOL);
      // Chỉ lần checkout của probe này: thay `SELECT 1` bằng query chậm, gọi đúng hàm query thật của client.
      const slowDown = (client: pg.PoolClient) => {
        const realQuery = client.query.bind(client);
        vi.spyOn(client, 'query').mockImplementationOnce(() =>
          realQuery(SLOW_PROBE_SQL),
        );
      };
      pool.once('acquire', slowDown);
      try {
        await expectProbeFailsCleanly(
          app,
          async () => {
            await vi.waitFor(
              async () => {
                const { rowCount } = await killer.query(
                  `SELECT 1 FROM pg_stat_activity WHERE usename = 'auth_user' AND state = 'active' AND query = $1`,
                  [SLOW_PROBE_SQL],
                );
                expect(rowCount).toBe(1);
              },
              { timeout: IN_FLIGHT_WAIT_MS },
            );
            const killed = await killer.query(
              `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'auth_user' AND query = $1 AND pid <> pg_backend_pid()`,
              [SLOW_PROBE_SQL],
            );
            expect(killed.rowCount).toBe(1);
          },
          /./,
        );
      } finally {
        pool.off('acquire', slowDown);
      }
    });
  });

  describe('connection reset with the query in flight (no ErrorResponse first)', () => {
    let app: INestApplication;
    let proxy: TcpProxy;
    beforeAll(async () => {
      const { pg: p } = getInfra();
      proxy = await startTcpProxy(p.host, p.port);
      vi.stubEnv('DB_AUTH_HOST', '127.0.0.1');
      vi.stubEnv('DB_AUTH_PORT', String(proxy.port));
      vi.stubEnv('HEALTH_CHECK_TIMEOUT_MS', String(CHECK_TIMEOUT_MS));
      app = await createTestApp([M]);
    });
    afterAll(async () => {
      await app?.close();
      await proxy?.close();
      vi.unstubAllEnvs();
    });

    it('a reset mid-probe fails the probe without an uncaught exception', async () => {
      const pool = app.get<pg.Pool>(AUTH_POOL);
      await app.get(AuthDatabaseReadiness).probe();
      expect(pool.idleCount).toBe(1);
      await expectProbeFailsCleanly(
        app,
        async () => {
          // Query của probe tới proxy và bị giữ lại (blackhole), rồi cắt socket khi nó còn chạy.
          proxy.state.blackhole = true;
          await vi.waitFor(() => expect(pool.idleCount).toBe(0));
          await sleep(TRAILING_EVENTS_MS);
          proxy.sever();
          proxy.state.blackhole = false;
        },
        /Connection terminated unexpectedly/,
      );
    });
  });
});
