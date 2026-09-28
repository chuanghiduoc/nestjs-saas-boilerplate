import { Logger, type INestApplication } from '@nestjs/common';
import { getEntityManagerToken } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConfigOf, appConfig } from '../../../../src/core/config/index.js';
import { CorePoolShutdown } from '../../../../src/core/database/core-pools.js';
import {
  CorePools,
  DB_CONTEXT,
  DatabaseModule,
  Db,
  RelayDb,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import { toAppError } from '../../../../src/core/errors/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../../support/tcp-proxy.js';

/**
 * Tham số của spec (không phải config của app): deadline nhỏ để test nhanh, đủ lớn cho `select 1` qua loopback.
 * `LATENCY_MARGIN_MS` cho event loop; `HUNG_AFTER_MS`: quá mốc này coi là treo (thiếu deadline thì query chờ TCP
 * timeout của kernel, tính bằng phút).
 */
const QUERY_TIMEOUT_MS = 400;
const CONNECTION_TIMEOUT_MS = 300;
const LATENCY_MARGIN_MS = 1000;
/** `SET LOCAL statement_timeout` của job worker trong spec: luật cấu hình buộc nó dưới deadline worker. */
const WORKER_STATEMENT_TIMEOUT_MS = QUERY_TIMEOUT_MS - 100;
/** Timer của Node có thể nổ sớm vài ms so với mốc đo bằng `performance.now()`. */
const TIMER_SLACK_MS = 50;
/**
 * `HTTP_REQUEST_BUDGET_MS` của spec: hạn thu hồi checkout bị bỏ rơi; trên CONNECTION + 2 x QUERY như luật production, và
 * cách xa bound latency để thiếu `query_timeout` (chỉ bộ thu hồi cứu ở mốc ngân sách) vượt bound rõ ràng.
 */
const REQUEST_BUDGET_MS = 3000;
/** Số câu lỗi của phép đo M1 (review đo 2002; 400 đủ thấy ~5% nếu còn churn). */
const CHURN_PROBES = 400;
const HUNG_AFTER_MS = (CONNECTION_TIMEOUT_MS + 2 * QUERY_TIMEOUT_MS) * 4;

type Settled = 'hung' | { err: unknown; ms: number };
const settle = async (run: () => Promise<unknown>): Promise<Settled> => {
  const started = performance.now();
  const outcome = run().then(
    () => ({ err: undefined, ms: performance.now() - started }),
    (err: unknown) => ({ err, ms: performance.now() - started }),
  );
  return Promise.race([
    outcome,
    sleep(HUNG_AFTER_MS).then(() => 'hung' as const),
  ]);
};
const status = (r: Settled) =>
  r === 'hung'
    ? 'hung'
    : r.err === undefined
      ? 'resolved'
      : toAppError(r.err).error.status;

/**
 * S2-R67: pool MikroORM của core (connection `app`) trên mạng blackhole (mất gói, không RST). Không có hạn phía client
 * thì query trên socket đã mở và cả việc lấy connection mới treo vô hạn; `statement_timeout` của role nằm phía server
 * nên không chạy. `DB_POOL_MAX=1` buộc lần dùng sau (mạng đã lành) lấy lại đúng client vật lý đó nếu nó được trả về
 * pool, nên spec bắt được cả thiếu deadline (treo) lẫn thiếu huỷ (query sau khi lành vẫn quá hạn).
 */
describe('core pool: client-side deadlines on a blackholed network (S2-R67)', () => {
  let app: INestApplication | undefined;
  let proxy: TcpProxy | undefined;
  let relayProxy: TcpProxy | undefined;

  const nativePool = (context: string): Promise<pg.Pool> => {
    if (!app) throw new Error('app is not open');
    return app
      .get<EntityManager>(getEntityManagerToken(context))
      .getConnection()
      .getNativeClient();
  };

  /**
   * App với pool core qua proxy TCP (`DB_POOL_MAX=1`). Worker: deadline worker nhỏ (luật cấu hình buộc
   * `DB_WORKER_STATEMENT_TIMEOUT_MS` < deadline), và tuỳ chọn connection `relay` qua proxy thứ hai (Postgres trực tiếp).
   */
  const open = async (
    role: 'api' | 'worker' = 'api',
    opts: { relay?: boolean } = {},
  ) => {
    const { pgbouncer, pg: direct } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    vi.stubEnv('APP_ROLE', role);
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_PORT', String(proxy.port));
    vi.stubEnv('DB_POOL_MAX', '1');
    vi.stubEnv('DB_QUERY_TIMEOUT_MS', String(QUERY_TIMEOUT_MS));
    vi.stubEnv('DB_CONNECTION_TIMEOUT_MS', String(CONNECTION_TIMEOUT_MS));
    vi.stubEnv('HTTP_REQUEST_BUDGET_MS', String(REQUEST_BUDGET_MS));
    vi.stubEnv(
      'DB_WORKER_STATEMENT_TIMEOUT_MS',
      String(WORKER_STATEMENT_TIMEOUT_MS),
    );
    vi.stubEnv('DB_WORKER_QUERY_TIMEOUT_MS', String(QUERY_TIMEOUT_MS));
    vi.stubEnv('DB_WORKER_CONNECTION_TIMEOUT_MS', String(QUERY_TIMEOUT_MS));
    if (opts.relay) {
      relayProxy = await startTcpProxy(direct.host, direct.port);
      vi.stubEnv('DB_RELAY_HOST', '127.0.0.1');
      vi.stubEnv('DB_RELAY_PORT', String(relayProxy.port));
      vi.stubEnv('DB_RELAY_POOL_MAX', '1');
    }
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: opts.relay === true }),
    ]);
    const pool = await nativePool(DB_CONTEXT.app);
    const db = app.get(Db);
    // Pool ẤM: client vật lý đã kết nối và đang rảnh khi mạng bị cắt; pool nguội thì mọi query đi đường kết nối mới.
    await db.execute('select 1');
    expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({
      total: 1,
      idle: 1,
    });
    return { pool, db, uow: app.get(UnitOfWork), proxy };
  };

  afterEach(async () => {
    // Cắt socket TRƯỚC khi đóng app: nếu thiếu deadline, query treo chỉ nhả client khi socket chết.
    await proxy?.close();
    await relayProxy?.close();
    await app?.close();
    vi.unstubAllEnvs();
    app = undefined;
    proxy = undefined;
    relayProxy = undefined;
  });

  it('api role: the pool carries the configured deadlines, and MikroORM keeps its own pool error listeners', async () => {
    const { pool } = await open();
    expect(pool.options).toMatchObject({
      query_timeout: QUERY_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });
    // PostgreSqlConnection.handlePoolErrors: 'error' của pool và 'connect' (gắn 'error' cho từng client).
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(pool.listenerCount('connect')).toBeGreaterThanOrEqual(1);
    // Huỷ client kẹt + dọn timer thu hồi checkout.
    expect(pool.listenerCount('release')).toBe(2);
    expect(pool.listenerCount('acquire')).toBe(1);
  });

  it('worker role: the app and relay pools carry the worker deadlines and the same guards', async () => {
    const { pool } = await open('worker', { relay: true });
    const relay = await nativePool(DB_CONTEXT.relay);
    for (const p of [pool, relay]) {
      expect(p.options).toMatchObject({
        query_timeout: QUERY_TIMEOUT_MS,
        connectionTimeoutMillis: QUERY_TIMEOUT_MS,
      });
      // Không có bộ thu hồi theo thời gian ở worker; trả slot khi connection chết vẫn có.
      expect(p.listenerCount('release')).toBe(2);
      expect(p.listenerCount('acquire')).toBe(1);
    }
  });

  it('Db.execute outside a transaction rejects within the query deadline as 503; the stuck client is destroyed and the pool recovers', async () => {
    const t = await open();
    t.proxy.state.blackhole = true;

    const r = await settle(() => t.db.execute('select 1'));

    expect(status(r)).toBe(503);
    if (r === 'hung') return;
    expect(r.ms).toBeLessThanOrEqual(QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS);
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0));

    t.proxy.state.blackhole = false;
    await expect(t.db.execute('select 1 as ok')).resolves.toEqual([{ ok: 1 }]);
  });

  /**
   * Kysely 0.29.6 `ControlledTransaction` chỉ trả connection sau ROLLBACK thành công; ROLLBACK quá hạn thì slot mất vĩnh
   * viễn nếu không có `reapAbandonedCheckouts` (DB_POOL_MAX=1: mọi query sau chờ slot và 503 mãi).
   */
  it('a UnitOfWork transaction rejects within connect + query + ROLLBACK deadlines as 503; its client is never returned to the pool and its slot comes back within the request budget', async () => {
    const t = await open();
    const r = await settle(() =>
      t.uow.run(async () => {
        await t.db.execute('select 1');
        // Cắt mạng giữa transaction: BEGIN đã chạy trên client vật lý duy nhất.
        t.proxy.state.blackhole = true;
        await t.db.execute('select 2');
      }),
    );

    expect(status(r)).toBe(503);
    if (r === 'hung') return;
    expect(r.ms).toBeLessThanOrEqual(
      CONNECTION_TIMEOUT_MS + 2 * QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS,
    );
    expect(t.pool.idleCount).toBe(0);
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0), {
      timeout: REQUEST_BUDGET_MS + LATENCY_MARGIN_MS,
    });

    t.proxy.state.blackhole = false;
    await expect(
      t.uow.run(() => t.db.execute('select 1 as ok')),
    ).resolves.toEqual([{ ok: 1 }]);
  });

  /**
   * Review S2-R60 (carry-forward S2-R67): pg chỉ xoá timer `query_timeout` qua `query.callback` (client.js:733-736),
   * còn pg-cursor không bao giờ gọi nó, nên timer của một query cursor (MikroORM `stream()`, dialect có `cursor`)
   * LUÔN nổ sau deadline, kể cả khi cursor đã xong và client đã sang checkout khác. Nó vô hại chỉ khi
   * `Cursor.handleError` thấy `state === 'done'` và không gửi `Sync` (pg-cursor index.js:156); Kysely `streamQuery`
   * luôn `await cursor.close()` (đặt `done`, chờ ReadyForQuery) trước khi trả client. `DB_POOL_MAX=1`: mọi query sau
   * chạy trên đúng client đó trong lúc timer nổ. Một `Sync` lạc giữa hai query thường vô hại (chỉ thêm một ReadyForQuery
   * lúc client rảnh — đã thử: chỉ dò bằng query thường thì mutation bỏ chốt `done` của pg-cursor vẫn xanh); nó phá hỏng
   * một trao đổi extended-protocol ĐANG DỞ: `Sync` kết thúc transaction ngầm và huỷ portal có tên của cursor khác. Nên
   * phép dò là các stream đọc từng hàng, chậm, phủ kín thời điểm timer nổ, rồi một query thường.
   */
  const STREAM_PROBE_ROWS = 10;
  const STREAM_PROBE_ROW_DELAY_MS = 20;
  const streamRows = async (
    sql: string,
    chunkSize: number,
    perRow: () => Promise<unknown> = () => Promise.resolve(),
  ) => {
    const rows: unknown[] = [];
    const stream = app
      ?.get<EntityManager>(getEntityManagerToken(DB_CONTEXT.app))
      .getConnection()
      .stream(sql, [], undefined, undefined, chunkSize);
    if (!stream) throw new Error('app is not open');
    for await (const row of stream) {
      rows.push(row);
      await perRow();
    }
    return rows;
  };
  const clientStaysInStepAcross = async (db: Db, untilMs: number) => {
    const expected = Array.from({ length: STREAM_PROBE_ROWS }, (_, i) => ({
      g: i + 1,
    }));
    let probes = 0;
    for (; performance.now() < untilMs; probes++)
      expect(
        await streamRows(
          `select g from generate_series(1, ${STREAM_PROBE_ROWS}) g`,
          1,
          () => sleep(STREAM_PROBE_ROW_DELAY_MS),
        ),
      ).toEqual(expected);
    expect(probes).toBeGreaterThan(0);
    expect(await db.execute('select ?::int as n', [probes])).toEqual([
      { n: probes },
    ]);
  };

  it.each([
    [
      'a successful stream',
      'select g from generate_series(1, 3) g',
      'resolved',
    ],
    [
      'a stream failing server-side mid-way',
      'select 1 / (g - 2) as x from generate_series(1, 3) g',
      500,
    ],
  ])(
    '%s leaves no stray protocol message when its query_timeout timer fires later on the reused client',
    async (_name, sql, expected) => {
      const t = await open();
      const started = performance.now();
      expect(status(await settle(() => streamRows(sql, 1)))).toBe(expected);
      await clientStaysInStepAcross(
        t.db,
        started + QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS,
      );
      expect(t.pool.totalCount).toBe(1);
    },
  );

  it('a stream running past the query deadline is cut as 503 (api policy), and the client is still in step afterwards', async () => {
    const t = await open();
    const started = performance.now();
    // 20 hàng x 50 ms, mỗi lần đọc 1 hàng: ~1 s > QUERY_TIMEOUT_MS, vẫn dưới statement_timeout của role (5 s).
    const r = await settle(() =>
      streamRows('select g, pg_sleep(0.05) from generate_series(1, 20) g', 1),
    );
    expect(status(r)).toBe(503);
    await clientStaysInStepAcross(
      t.db,
      started + QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS,
    );
  });

  it('a checkout held past the request budget is reaped: its next query fails as 503, the late release by the holder is harmless, and the slot is reused', async () => {
    const t = await open();
    const r = await settle(() =>
      t.uow.run(async () => {
        await t.db.execute('select 1');
        // Người giữ bận việc ngoài DB lâu hơn ngân sách, rồi dùng lại transaction.
        await sleep(REQUEST_BUDGET_MS + LATENCY_MARGIN_MS / 2);
        await t.db.execute('select 2');
      }),
    );
    expect(status(r)).toBe(503);
    await expect(t.db.execute('select 1 as ok')).resolves.toEqual([{ ok: 1 }]);
    expect(t.pool.totalCount).toBe(1);
  });

  /**
   * S2-R70 I1/I2: connection chết giữa transaction (failover, PgBouncer restart, `pg_terminate_backend`): ROLLBACK lỗi
   * ngay và kysely không trả slot. Slot phải về NGAY khi connection chết (không đợi bộ thu hồi của api), ở mọi vai trò,
   * và request trả 503 (không phải 500).
   */
  it.each(['api', 'worker'] as const)(
    '%s role: a connection reset mid-transaction answers 503 and returns its slot at once; the next query succeeds',
    async (role) => {
      const t = await open(role);
      const started = performance.now();
      const r = await settle(() =>
        t.uow.run(async () => {
          await t.db.execute('select 1');
          t.proxy.sever();
          await t.db.execute('select 2');
        }),
      );
      expect(status(r)).toBe(503);
      await vi.waitFor(() => expect(t.pool.totalCount).toBe(0), {
        timeout: LATENCY_MARGIN_MS,
      });
      // Không phải bộ thu hồi của api (REQUEST_BUDGET_MS) trả slot.
      expect(performance.now() - started).toBeLessThan(REQUEST_BUDGET_MS);
      await expect(t.db.execute('select 1 as ok')).resolves.toEqual([
        { ok: 1 },
      ]);
    },
  );

  it('worker role, relay connection: a reset mid-transaction returns the relay slot and the next relay query succeeds', async () => {
    await open('worker', { relay: true });
    if (!app || !relayProxy) throw new Error('app is not open');
    const relayDb = app.get(RelayDb);
    const relay = await nativePool(DB_CONTEXT.relay);
    const cut = relayProxy;
    const r = await settle(() =>
      relayDb.transaction(async (tx) => {
        await tx.execute('select 1');
        cut.sever();
        await tx.execute('select 2');
      }),
    );
    expect(status(r)).toBe(503);
    await vi.waitFor(() => expect(relay.totalCount).toBe(0), {
      timeout: LATENCY_MARGIN_MS,
    });
    await expect(relayDb.execute('select 1 as ok')).resolves.toEqual([
      { ok: 1 },
    ]);
  });

  it('worker role: a query on a blackholed network rejects within the worker deadline; the stuck client is destroyed and the pool recovers', async () => {
    const t = await open('worker');
    t.proxy.state.blackhole = true;
    const r = await settle(() => t.db.execute('select 1'));
    expect(status(r)).toBe(503);
    if (r === 'hung') return;
    expect(r.ms).toBeLessThanOrEqual(QUERY_TIMEOUT_MS + LATENCY_MARGIN_MS);
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0));
    t.proxy.state.blackhole = false;
    await expect(t.db.execute('select 1 as ok')).resolves.toEqual([{ ok: 1 }]);
  });

  it('a COMMIT that gets no answer is commit_outcome_unknown (503), not a plain service_unavailable', async () => {
    const t = await open();
    const r = await settle(() =>
      t.uow.run(async () => {
        await t.db.execute('select 1');
        // Mọi câu của callback đã xong; chỉ còn COMMIT, và nó rơi vào blackhole.
        t.proxy.state.blackhole = true;
      }),
    );
    if (r === 'hung' || r.err === undefined)
      throw new Error('expected a failure');
    expect(toAppError(r.err).error).toMatchObject({
      code: 'commit_outcome_unknown',
      status: 503,
    });
  });

  it('a statement failing server-side inside the transaction keeps its own mapping (not commit_outcome_unknown)', async () => {
    const t = await open();
    const r = await settle(() => t.uow.run(() => t.db.execute('select 1 / 0')));
    if (r === 'hung' || r.err === undefined)
      throw new Error('expected a failure');
    expect(toAppError(r.err).error.code).toBe('internal_error');
  });

  it('shutdown: a checkout still held after the drain is released at APP_SHUTDOWN_TIMEOUT_MS - APP_SHUTDOWN_RESERVE_MS, so the pool closes', async () => {
    const t = await open();
    if (!app) throw new Error('app is not open');
    // Checkout bị bỏ rơi: BEGIN trên mạng blackhole quá hạn, kysely không trả slot, bộ thu hồi của api còn xa.
    t.proxy.state.blackhole = true;
    await settle(() => t.uow.run(() => t.db.execute('select 1')));
    const pools = app.get(CorePools);
    expect(pools.checkedOut()).toBe(1);
    const shutdownMs = 600;
    const reserveMs = 200;
    const started = performance.now();
    new CorePoolShutdown(pools, {
      ...app.get<ConfigOf<typeof appConfig>>(appConfig.KEY),
      shutdownTimeoutMs: shutdownMs,
      shutdownReserveMs: reserveMs,
    }).onModuleDestroy();
    await vi.waitFor(() => expect(pools.checkedOut()).toBe(0), {
      timeout: shutdownMs + LATENCY_MARGIN_MS,
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      shutdownMs - reserveMs - TIMER_SLACK_MS,
    );
    const closing = performance.now();
    await app.close();
    app = undefined;
    expect(performance.now() - closing).toBeLessThan(LATENCY_MARGIN_MS);
  });

  /**
   * S2-R70 M1: lỗi SQL ngoài transaction qua PgBouncer. pg reject ở ErrorResponse, Kysely trả client trước khi
   * ReadyForQuery tới (review đo ~5-6% qua PgBouncer 1.25.2). Client đó lành: không được huỷ.
   */
  it('failed statements outside a transaction through PgBouncer never destroy a healthy client', async () => {
    const t = await open();
    const removed: unknown[] = [];
    t.pool.on('remove', (c) => removed.push(c));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      for (let i = 0; i < CHURN_PROBES; i++)
        await expect(
          i % 2 === 0
            ? t.db.execute('select 1 / 0')
            : t.db.execute('select 1 / (? - ?)', [i, i]),
        ).rejects.toThrow(/division by zero/);
      const destroyed = warn.mock.calls.filter(
        ([fields]) =>
          typeof fields === 'object' &&
          fields !== null &&
          'event' in fields &&
          fields.event === 'db_pool_client_destroyed',
      );
      expect({
        destroyed: destroyed.length,
        removed: removed.length,
      }).toEqual({ destroyed: 0, removed: 0 });
      expect(t.pool.totalCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a cold checkout on a blackholed network rejects within the connection deadline as 503', async () => {
    const t = await open();
    t.proxy.sever();
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0));
    t.proxy.state.blackhole = true;

    const r = await settle(() => t.db.execute('select 1'));

    expect(status(r)).toBe(503);
    if (r === 'hung') return;
    expect(r.ms).toBeLessThanOrEqual(CONNECTION_TIMEOUT_MS + LATENCY_MARGIN_MS);

    t.proxy.state.blackhole = false;
    await expect(t.db.execute('select 1 as ok')).resolves.toEqual([{ ok: 1 }]);
  });
});
