import { Logger } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { isAuthInfraError } from '../../../src/modules/identity/infra/better-auth/auth-error.mapper.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { UnverifiedLinkRevoker } from '../../../src/modules/identity/infra/better-auth/unverified-links.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../support/tcp-proxy.js';

/** `DB_AUTH_QUERY_TIMEOUT_MS` của spec này: đủ lớn cho `select 1` qua loopback, đủ nhỏ để test nhanh. */
const QUERY_TIMEOUT_MS = 400;
/** Phần cộng thêm cho event loop khi đo độ trễ; nhỏ hơn nhiều TCP timeout của kernel (phút). */
const LATENCY_MARGIN_MS = 1000;
/** Quá mốc này thì coi là treo: không có deadline thì query chờ TCP timeout của kernel. */
const HUNG_AFTER_MS = QUERY_TIMEOUT_MS * 6;
/**
 * Lý do một client của pool auth không về pool, từ log (S2-R70: cơ chế của core). `db_pool_client_destroyed` (core
 * `destroyUnusableClients`, `pool: 'auth'`) mang `reason`; `auth_pool_client_released_with_error` (identity) là client
 * trả kèm lỗi, pg-pool tự bỏ; `db_pool_checkout_connection_lost` (core `watchPoolCheckouts`) là connection chết lúc đang
 * mượn.
 */
const poolEvents = (calls: readonly (readonly unknown[])[]): unknown[] =>
  calls.flatMap(([fields]) => {
    if (typeof fields !== 'object' || fields === null || !('event' in fields))
      return [];
    switch (fields.event) {
      case 'db_pool_client_destroyed':
        return 'reason' in fields ? [fields.reason] : [];
      case 'auth_pool_client_released_with_error':
        return [
          'code' in fields
            ? `released_with_error:${String(fields.code)}`
            : 'released_with_error',
        ];
      case 'db_pool_checkout_connection_lost':
        return ['checkout_connection_lost'];
      default:
        return [];
    }
  });
/** Độ lệch cho phép của timer Node khi kiểm chặn DƯỚI (timer có thể bắn sớm vài ms so với đồng hồ đo). */
const TIMER_SLACK_MS = 20;

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
  // Review N3: mỗi client bị huỷ log một WARN (cố ý); im lặng và kiểm lý do của nó.
  const spyWarn = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  let warn: ReturnType<typeof spyWarn> | undefined;
  const destroyedReasons = () => poolEvents(warn?.mock.calls ?? []);

  const open = async () => {
    const { pg: p } = getInfra();
    warn = spyWarn();
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
    warn?.mockRestore();
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
    expect(destroyedReasons()).toEqual(['not_ready_for_query']);

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
    expect(destroyedReasons()).toEqual(['not_ready_for_query']);

    t.proxy.state.blackhole = false;
    await expect(t.pool.query('select 1 as ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });

  it('review M5: a fence/reclaim transaction (unverified-links) pays the query deadline twice (the ROLLBACK queues behind the stuck query), then its client is destroyed', async () => {
    const t = await open();
    t.proxy.state.blackhole = true;

    const r = await settle(() =>
      new UnverifiedLinkRevoker(t.pool).revoke(v7(), 'email-verification'),
    );

    expect(r).not.toBe('hung');
    if (r === 'hung') return;
    expect(isAuthInfraError(r.err)).toBe(true);
    // Chặn dưới chứng minh ROLLBACK thật sự chờ hết hạn của riêng nó (chân 2 x Q của luật identity-auth-query-deadline).
    expect(r.ms).toBeGreaterThanOrEqual(2 * QUERY_TIMEOUT_MS - TIMER_SLACK_MS);
    expect(r.ms).toBeLessThanOrEqual(2 * QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS);
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0));
    // ROLLBACK cũng quá hạn → `transaction()` release kèm lỗi (pg-pool tự bỏ client).
    expect(destroyedReasons()).toEqual(['released_with_error']);

    t.proxy.state.blackhole = false;
    await expect(t.pool.query('select 1 as ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });
});

/** Luật trả client về pool (review M1–M3), trên mạng bình thường. */
describe('auth_user pool: which released clients go back to the pool (S2-R60 review M1-M3)', () => {
  let pool: pg.Pool | undefined;
  let proxy: TcpProxy | undefined;
  const spyWarn = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  let warn: ReturnType<typeof spyWarn> | undefined;
  const destroyed = () => poolEvents(warn?.mock.calls ?? []);
  const open = async () => {
    const { pg: p } = getInfra();
    proxy = await startTcpProxy(p.host, p.port);
    applyTestEnv();
    vi.stubEnv('DB_AUTH_HOST', '127.0.0.1');
    vi.stubEnv('DB_AUTH_PORT', String(proxy.port));
    vi.stubEnv('DB_AUTH_POOL_MAX', '1');
    warn = spyWarn();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    await pool.query('select 1');
    expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({
      total: 1,
      idle: 1,
    });
    expect(destroyed()).toEqual([]);
    return pool;
  };
  afterEach(async () => {
    await proxy?.close();
    await pool?.end();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    pool = undefined;
    proxy = undefined;
  });

  it('M1: a client released with an error is logged with its real reason and ended exactly once (by pg-pool)', async () => {
    const p = await open();
    const end = vi.spyOn(pg.Client.prototype, 'end');
    await expect(p.query('select 1/0')).rejects.toMatchObject({
      code: '22012',
    });
    await vi.waitFor(() => expect(p.totalCount).toBe(0));
    expect(end).toHaveBeenCalledTimes(1);
    expect(destroyed()).toEqual(['released_with_error:22012']);
    await expect(p.query('select 1 as ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });

  it.each([
    ['T (inside a transaction)', ['BEGIN'], 'T'],
    ['E (failed transaction, no ROLLBACK)', ['BEGIN', 'select 1/0'], 'E'],
  ])(
    'M3: a client released with transaction status %s is destroyed, never reused',
    async (_label, statements, status) => {
      const p = await open();
      const client = await p.connect();
      for (const q of statements) await client.query(q).catch(() => undefined);
      // pg reject query lỗi ngay ở ErrorResponse; `getTransactionStatus()` chỉ thành 'E' khi ReadyForQuery('E') tới sau đó.
      // Release trong khoảng đó là ca S2-R70 (`not_ready_for_query`, test riêng bên dưới), không phải ca M3 này: chờ
      // đúng trạng thái transaction mà ca này mô tả rồi mới release.
      await vi.waitFor(() =>
        expect(client.getTransactionStatus()).toBe(status),
      );
      client.release();
      await vi.waitFor(() => expect(p.totalCount).toBe(0));
      expect(destroyed()).toEqual(['open_transaction']);
      // Client mới, ngoài transaction: không thừa hưởng 25P02 hay lock của người trước.
      await expect(
        p.query("select current_setting('transaction_isolation') as t"),
      ).resolves.toMatchObject({ rowCount: 1 });
    },
  );

  it('M2 rule: a client released before ReadyForQuery (query still in flight) is destroyed', async () => {
    const p = await open();
    const client = await p.connect();
    const inFlight = client.query('select pg_sleep(0.3)');
    client.release();
    await expect(inFlight).rejects.toThrow(/Connection terminated/);
    await vi.waitFor(() => expect(p.totalCount).toBe(0));
    expect(destroyed()).toEqual(['not_ready_for_query']);
  });

  it('S2-R70: a server error released before ReadyForQuery keeps a healthy client (no churn on SQL errors)', async () => {
    const p = await open();
    const client = await p.connect();
    // Kysely trả client ngay khi promise reject ở ErrorResponse; ReadyForQuery có thể chưa tới.
    await client.query('select 1/0').catch(() => undefined);
    client.release();
    await expect(p.query('select 1 as ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
    expect(destroyed()).toEqual([]);
  });

  it('S2-R70: a checked-out connection that dies (socket cut while held) returns its slot to the pool; the late release of the borrower is a no-op', async () => {
    const p = await open();
    const client = await p.connect();
    expect({ total: p.totalCount, idle: p.idleCount }).toEqual({
      total: 1,
      idle: 0,
    });
    // Cắt socket khi client đang được mượn và RẢNH (vd. giữa hai câu của một transaction, PgBouncer restart).
    proxy?.sever();
    await vi.waitFor(() => expect(p.totalCount).toBe(0));
    expect(destroyed()).toContain('checkout_connection_lost');
    // Slot đã về: query sau (POOL_MAX=1) chạy ngay trên connection mới thay vì chờ mãi.
    await expect(p.query('select 1 as ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
    // Người mượn trả muộn (như ROLLBACK lỗi rồi release): không ném "already been released".
    expect(() => client.release()).not.toThrow();
  });

  it('a healthy client released after a completed query outside a transaction goes back to the pool', async () => {
    const p = await open();
    const client = await p.connect();
    await client.query('BEGIN');
    await client.query('COMMIT');
    client.release();
    expect({ total: p.totalCount, idle: p.idleCount }).toEqual({
      total: 1,
      idle: 1,
    });
    expect(destroyed()).toEqual([]);
  });
});
