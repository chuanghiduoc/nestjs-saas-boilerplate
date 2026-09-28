import { Kysely, PostgresDialect, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { isAuthInfraError } from '../../../src/modules/identity/infra/better-auth/auth-error.mapper.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../support/tcp-proxy.js';

/** `DB_AUTH_QUERY_TIMEOUT_MS` của spec này: đủ lớn cho `select 1` qua loopback, đủ nhỏ để test nhanh. */
const QUERY_TIMEOUT_MS = 400;
/** Phần cộng thêm cho event loop khi đo độ trễ; nhỏ hơn nhiều TCP timeout của kernel (phút). */
const LATENCY_MARGIN_MS = 1000;
/** Quá mốc này thì coi là treo: không có deadline thì query chờ TCP timeout của kernel. */
const HUNG_AFTER_MS = QUERY_TIMEOUT_MS * 6;

const hungAfter = (ms: number) => sleep(ms).then(() => 'hung' as const);
/** Kết quả của một thao tác phải bị chặn bởi deadline: `hung`, hoặc lỗi kèm thời gian. */
const settle = async (
  run: () => Promise<unknown>,
): Promise<'hung' | { err: unknown; ms: number }> => {
  const started = performance.now();
  const outcome = run().then(
    () => ({ err: undefined, ms: performance.now() - started }),
    (err: unknown) => ({ err, ms: performance.now() - started }),
  );
  return Promise.race([outcome, hungAfter(HUNG_AFTER_MS)]);
};

/**
 * S2-R60: mạng tới DB auth bị blackhole (mất gói, không RST). `connectionTimeoutMillis` chỉ chặn lúc kết nối,
 * `statement_timeout` nằm phía server nên không bao giờ chạy. Pool `auth_user` phải có hạn phía client cho MỌI
 * query (Kysely/Better Auth, transaction tự viết, probe), và client quá hạn phải bị HUỶ, không trả về pool: pg
 * 8.23 (non-pipeline) để client quá hạn kẹt `readyForQuery = false`, query sau xếp hàng sau query không bao giờ
 * xong. `DB_AUTH_POOL_MAX=1` buộc lần dùng sau (khi mạng đã lành) phải lấy lại đúng client vật lý đó nếu nó được
 * trả về pool, nên test phát hiện được cả thiếu deadline (treo) lẫn thiếu huỷ (query sau khi lành vẫn quá hạn).
 */
describe('auth_user pool: client-side query deadline on a blackholed network (S2-R60)', () => {
  let pool: pg.Pool | undefined;
  let db: Kysely<Record<string, unknown>> | undefined;
  let proxy: TcpProxy | undefined;

  const open = async () => {
    const { pg: p } = getInfra();
    proxy = await startTcpProxy(p.host, p.port);
    applyTestEnv();
    vi.stubEnv('DB_AUTH_HOST', '127.0.0.1');
    vi.stubEnv('DB_AUTH_PORT', String(proxy.port));
    vi.stubEnv('DB_AUTH_POOL_MAX', '1');
    vi.stubEnv('DB_AUTH_QUERY_TIMEOUT_MS', String(QUERY_TIMEOUT_MS));
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    db = new Kysely<Record<string, unknown>>({
      dialect: new PostgresDialect({ pool }),
    });
    // Pool ẤM: client vật lý đã kết nối và đang rảnh khi mạng bị cắt (Task 42 review Minor 2). Pool nguội thì mọi
    // query đi đường kết nối mới và `DB_AUTH_CONNECTION_TIMEOUT_MS` trả lời thay, test xanh mà không chạm B1.
    await sql`select 1`.execute(db);
    expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({
      total: 1,
      idle: 1,
    });
    return { pool, db, proxy };
  };

  afterEach(async () => {
    // Cắt socket TRƯỚC khi đóng pool: nếu thiếu deadline, query treo chỉ nhả client khi socket chết, còn
    // `pool.end()` thì chờ mọi client đang checkout được trả về.
    await proxy?.close();
    await db?.destroy();
    vi.unstubAllEnvs();
    pool = undefined;
    db = undefined;
    proxy = undefined;
  });

  it('a Kysely query (the Better Auth path) rejects within the deadline as an infra error; the stuck client is destroyed and the pool recovers', async () => {
    const t = await open();
    t.proxy.state.blackhole = true;

    const r = await settle(() => sql`select 1`.execute(t.db));

    expect(r).not.toBe('hung');
    if (r === 'hung') return;
    expect(r.err).toBeInstanceOf(Error);
    expect(isAuthInfraError(r.err)).toBe(true);
    expect(r.ms).toBeLessThanOrEqual(QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS);
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0));

    t.proxy.state.blackhole = false;
    await expect(
      sql<{ ok: number }>`select 1 as ok`.execute(t.db),
    ).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('a checked-out client in a transaction (fence/reclaim shape) rejects within the deadline and is never returned to the pool', async () => {
    const t = await open();
    const client = await t.pool.connect();
    await client.query('BEGIN');
    t.proxy.state.blackhole = true;

    const r = await settle(() =>
      client.query('SELECT 1 FROM auth."user" LIMIT 1 FOR UPDATE'),
    );
    // Caller bình thường không biết client đã hỏng: release KHÔNG kèm lỗi (như Kysely `releaseConnection`).
    client.release();

    expect(r).not.toBe('hung');
    if (r === 'hung') return;
    expect(isAuthInfraError(r.err)).toBe(true);
    expect(r.ms).toBeLessThanOrEqual(QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS);
    expect(t.pool.idleCount).toBe(0);
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0));

    t.proxy.state.blackhole = false;
    await expect(t.pool.query('select 1 as ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });
});
