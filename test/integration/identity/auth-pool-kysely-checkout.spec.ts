import { Kysely, PostgresDialect, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../support/tcp-proxy.js';

/** Query chậm để cắt được giữa chừng; nhận diện lại đúng câu này qua `pg_stat_activity`. */
const SLOW_SQL = 'select pg_sleep(5)';
const IN_FLIGHT_WAIT_MS = 5000;
/** Chờ thêm sau khi severed để `'error'` đến muộn của socket (nếu có) kịp phát trước khi kiểm `uncaughtException`. */
const TRAILING_EVENTS_MS = 300;

/**
 * S2-R32: Better Auth chạm `auth_user` qua Kysely `PostgresDialect`, checkout client bằng `pool.connect()`
 * (kysely `postgres-driver.js`, `PostgresDriver.acquireConnection`) và không tự gắn listener `'error'` nào —
 * đúng lỗ hổng đã làm probe `auth-readiness.ts` sập process trước khi vá ở fix round 2 (khác lý do: probe tự
 * gắn listener tạm để fail nhanh, còn đây là consumer bất kỳ không biết phải tự gắn).
 *
 * Vá ở `createAuthPool` (không phải ở đây): `pool.on('connect', client => client.on('error', handler))` gắn
 * listener permanent cho MỌI client vật lý ngay khi nó được tạo — phủ toàn bộ đời client (rảnh hay đang
 * checkout), không phụ thuộc Kysely hay bất cứ consumer nào tự làm đúng.
 *
 * Dựng Kysely giống hệt `auth.cli-config.ts` (CLI `auth` thật): `new Kysely({ dialect: new
 * PostgresDialect({ pool: createAuthPool(...) }) })`, trỏ qua `test/support/tcp-proxy.ts` để cắt socket khi
 * `SLOW_SQL` còn đang chạy (không có ErrorResponse trước — pg phát `'error'` đồng bộ trên client).
 */
describe('auth_user pool via Kysely PostgresDialect: a mid-query socket reset on a checked-out client', () => {
  let pool: pg.Pool | undefined;
  let db: Kysely<Record<string, unknown>> | undefined;
  let proxy: TcpProxy | undefined;
  let monitor: pg.Client | undefined;

  afterEach(async () => {
    await db?.destroy();
    await monitor?.end();
    await proxy?.close();
    vi.unstubAllEnvs();
    pool = undefined;
    db = undefined;
    monitor = undefined;
    proxy = undefined;
  });

  it('does not crash the process; the query rejects; the pool still works afterwards', async () => {
    const { pg: p } = getInfra();
    // Đi thẳng Postgres qua proxy (không PgBouncer): PgBouncer transaction mode giữ socket client mở khi
    // backend chết, nên phải cắt ở tầng TCP để pg phát 'error' đồng bộ đúng như review đã xác nhận.
    proxy = await startTcpProxy(p.host, p.port);
    applyTestEnv();
    vi.stubEnv('DB_AUTH_HOST', '127.0.0.1');
    vi.stubEnv('DB_AUTH_PORT', String(proxy.port));

    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    db = new Kysely<Record<string, unknown>>({
      dialect: new PostgresDialect({ pool }),
    });

    // Client riêng, đi thẳng (không qua proxy), để soi pg_stat_activity xem SLOW_SQL đã thật sự chạy trên
    // server chưa trước khi cắt — tránh cắt quá sớm (query chưa gửi) làm test flaky.
    monitor = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.auth,
    });
    await monitor.connect();

    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): number => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const running = sql`select pg_sleep(5)`.execute(db);
      running.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const { rowCount } = await monitor!.query(
            `SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND state = 'active' AND query = $2`,
            [p.auth.user, SLOW_SQL],
          );
          expect(rowCount).toBe(1);
        },
        { timeout: IN_FLIGHT_WAIT_MS },
      );
      proxy.sever();
      await expect(running).rejects.toThrow(
        /Connection terminated unexpectedly/,
      );
      await sleep(TRAILING_EVENTS_MS);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    // Client hỏng bị pg-pool loại (client._queryable === false), pool tự phục hồi ở lần dùng sau.
    await expect(
      sql<{ ok: number }>`select 1 as ok`.execute(db),
    ).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
