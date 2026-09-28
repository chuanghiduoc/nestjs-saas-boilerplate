import { Logger, type INestApplication } from '@nestjs/common';
import { getEntityManagerToken } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConfigOf, appConfig } from '../../../../src/core/config/index.js';
import { CorePoolShutdown } from '../../../../src/core/database/core-pools.js';
import {
  CorePools,
  DB_CONTEXT,
  DatabaseModule,
  Db,
  DbStatementTimeoutCheck,
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
/** `DB_WORKER_CHECKOUT_MAX_MS` của spec: luật cấu hình buộc > 2 x deadline worker (800). */
const WORKER_CHECKOUT_MAX_MS = 1500;
/** Phần của `DB_WORKER_CHECKOUT_MAX_MS` mà job hợp lệ dùng trong test "không bị cắt". */
const INSIDE_ALLOWED_FRACTION = 0.6;
/** Timer của Node có thể nổ sớm vài ms so với mốc đo bằng `performance.now()`. */
const TIMER_SLACK_MS = 50;
/**
 * `HTTP_REQUEST_BUDGET_MS` của spec: hạn thu hồi checkout bị bỏ rơi; trên CONNECTION + 2 x QUERY như luật production, và
 * cách xa bound latency để thiếu `query_timeout` (chỉ bộ thu hồi cứu ở mốc ngân sách) vượt bound rõ ràng.
 */
const REQUEST_BUDGET_MS = 3000;
/** Số câu lỗi của phép đo M1 (review đo 2002; 400 đủ thấy ~5% nếu còn churn). */
const CHURN_PROBES = 400;
/** Hạn probe readiness của spec (`HEALTH_CHECK_TIMEOUT_MS`): dưới QUERY_TIMEOUT_MS để phân biệt với deadline của pool. */
const PROBE_TIMEOUT_MS = 200;
/** Chu kỳ lấy mẫu số slot bị chiếm trong lúc probe chạy. */
const PROBE_SAMPLE_MS = 10;
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
    vi.stubEnv('DB_WORKER_CHECKOUT_MAX_MS', String(WORKER_CHECKOUT_MAX_MS));
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
      // Trả slot khi connection chết và bộ thu hồi DB_WORKER_CHECKOUT_MAX_MS dùng chung listener 'acquire'.
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

  /**
   * S2-R72: mạng blackhole giữa transaction của worker. Câu kẹt quá deadline worker, ROLLBACK xếp hàng sau nó cũng quá hạn,
   * kysely không trả slot, socket vẫn mở nên không có 'end'. Slot phải về trong DB_WORKER_CHECKOUT_MAX_MS (+ margin),
   * không phải sau TCP timeout của kernel, và query sau (mạng đã lành) thành công.
   */
  it('worker role: a transaction blackholed mid-way gets its app slot back within DB_WORKER_CHECKOUT_MAX_MS; the next query succeeds after the heal', async () => {
    const t = await open('worker');
    const started = performance.now();
    const r = await settle(() =>
      t.uow.run(async () => {
        await t.db.execute('select 1');
        t.proxy.state.blackhole = true;
        await t.db.execute('select 2');
      }),
    );
    expect(status(r)).toBe(503);
    expect(t.pool.totalCount - t.pool.idleCount).toBe(1);
    await vi.waitFor(() => expect(t.pool.totalCount).toBe(0), {
      timeout: WORKER_CHECKOUT_MAX_MS + LATENCY_MARGIN_MS,
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      WORKER_CHECKOUT_MAX_MS - TIMER_SLACK_MS,
    );
    t.proxy.state.blackhole = false;
    await expect(t.db.execute('select 1 as ok')).resolves.toEqual([{ ok: 1 }]);
  });

  it('worker role, relay connection: a transaction blackholed mid-way gets its relay slot back within DB_WORKER_CHECKOUT_MAX_MS', async () => {
    await open('worker', { relay: true });
    if (!app || !relayProxy) throw new Error('app is not open');
    const relayDb = app.get(RelayDb);
    const relay = await nativePool(DB_CONTEXT.relay);
    const cut = relayProxy;
    const r = await settle(() =>
      relayDb.transaction(async (tx) => {
        await tx.execute('select 1');
        cut.state.blackhole = true;
        await tx.execute('select 2');
      }),
    );
    expect(status(r)).toBe(503);
    await vi.waitFor(() => expect(relay.totalCount).toBe(0), {
      timeout: WORKER_CHECKOUT_MAX_MS + LATENCY_MARGIN_MS,
    });
    cut.state.blackhole = false;
    await expect(relayDb.execute('select 1 as ok')).resolves.toEqual([
      { ok: 1 },
    ]);
  });

  it('worker role: a checkout still inside DB_WORKER_CHECKOUT_MAX_MS is never cut', async () => {
    const t = await open('worker');
    await expect(
      t.uow.run(async () => {
        await t.db.execute('select 1');
        // Việc ngoài DB của job, trong mức cho phép.
        await sleep(WORKER_CHECKOUT_MAX_MS * INSIDE_ALLOWED_FRACTION);
        return t.db.execute('select 2 as ok');
      }),
    ).resolves.toEqual([{ ok: 2 }]);
    expect(t.pool.totalCount).toBe(1);
  });

  it('RelayDb.transaction: a COMMIT that gets no answer is commit_outcome_unknown', async () => {
    await open('worker', { relay: true });
    if (!app || !relayProxy) throw new Error('app is not open');
    const relayDb = app.get(RelayDb);
    const cut = relayProxy;
    const r = await settle(() =>
      relayDb.transaction(async (tx) => {
        await tx.execute('select 1');
        cut.state.blackhole = true;
      }),
    );
    if (r === 'hung' || r.err === undefined)
      throw new Error('expected a failure');
    expect(toAppError(r.err).error).toMatchObject({
      code: 'commit_outcome_unknown',
      status: 503,
    });
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

  /**
   * Final review M1: readiness `database` trên mạng blackhole. `withTimeout` của terminus không huỷ được query; probe cũ
   * (qua `Db`/`RelayDb`) giữ slot của pool tới query deadline (worker 65 s) và pool relay chỉ có 2 slot. Probe phải thất
   * bại trong hạn của chính nó và không bao giờ chiếm slot nào — cả khi pool ấm lẫn khi pool nguội (connection đang mở
   * cũng tính vào `max` của pg-pool).
   */
  it.each(['warm', 'cold'] as const)(
    'worker role, %s pools: a blackholed readiness database probe fails within its own deadline and never holds an app or relay slot',
    async (temperature) => {
      const t = await open('worker', { relay: true });
      if (!app || !relayProxy) throw new Error('app is not open');
      const relayDb = app.get(RelayDb);
      const relay = await nativePool(DB_CONTEXT.relay);
      await relayDb.execute('select 1');
      if (temperature === 'cold') {
        t.proxy.sever();
        relayProxy.sever();
        await vi.waitFor(() =>
          expect(t.pool.totalCount + relay.totalCount).toBe(0),
        );
      }
      const before = { app: t.pool.totalCount, relay: relay.totalCount };
      t.proxy.state.blackhole = true;
      relayProxy.state.blackhole = true;
      const check = app.get(DbStatementTimeoutCheck);
      const pools = app.get(CorePools);
      let heldDuringProbe = 0;
      const watch = setInterval(() => {
        heldDuringProbe = Math.max(
          heldDuringProbe,
          pools.checkedOut(),
          t.pool.totalCount - before.app,
          relay.totalCount - before.relay,
        );
      }, PROBE_SAMPLE_MS);
      try {
        const r = await settle(() => check.run(PROBE_TIMEOUT_MS));
        if (r === 'hung' || r.err === undefined)
          throw new Error('expected the probe to fail');
        // Kết nối và query, mỗi bước có hạn PROBE_TIMEOUT_MS.
        expect(r.ms).toBeLessThanOrEqual(
          2 * PROBE_TIMEOUT_MS + LATENCY_MARGIN_MS,
        );
      } finally {
        clearInterval(watch);
      }
      expect(heldDuringProbe).toBe(0);
      expect(pools.checkedOut()).toBe(0);
      t.proxy.state.blackhole = false;
      relayProxy.state.blackhole = false;
      await expect(check.run(PROBE_TIMEOUT_MS)).resolves.toBeUndefined();
    },
  );

  /**
   * Final review M2: backend của một client RẢNH bị `pg_terminate_backend` → pg-pool phát 'error' trên pool. Không có
   * `DB_DEBUG`, listener của MikroORM không log gì; pool core phải log `db_pool_idle_error` kèm SQLSTATE qua
   * `logPoolEvent`. Connection relay đi thẳng Postgres (qua proxy TCP), nên tín hiệu tới đúng client của pool; kẻ kill
   * đăng nhập bằng chính `app_relay` (role được signal backend của mình) và chỉ kill đúng pid của pool này.
   */
  it('an idle core_relay client killed by the server logs db_pool_idle_error with its SQLSTATE, pool-scoped fields only', async () => {
    vi.stubEnv('DB_DEBUG', 'false');
    await open('worker', { relay: true });
    if (!app) throw new Error('app is not open');
    const relay = await nativePool(DB_CONTEXT.relay);
    const [row] = await app
      .get(RelayDb)
      .execute<{ pid: number }>('select pg_backend_pid() as pid');
    if (!row) throw new Error('no backend pid');
    expect(relay.idleCount).toBe(1);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { pg: direct } = getInfra();
    const killer = new pg.Client({
      host: direct.host,
      port: direct.port,
      database: direct.database,
      ...direct.relay,
    });
    await killer.connect();
    try {
      await killer.query('select pg_terminate_backend($1)', [row.pid]);
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          {
            event: 'db_pool_idle_error',
            pool: 'core_relay',
            code: '57P01',
            name: 'error',
          },
          expect.any(String),
        ),
      );
      await vi.waitFor(() => expect(relay.totalCount).toBe(0));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(direct.relay.user);
    } finally {
      await killer.end();
      warn.mockRestore();
    }
  });

  /** Trạng thái thật của transaction `xid` (qua Postgres trực tiếp, ngoài proxy): bằng chứng commit đã bền hay chưa. */
  const txStatus = async (xid: string): Promise<string> => {
    const { pg: direct } = getInfra();
    const admin = new pg.Client({
      host: direct.host,
      port: direct.port,
      database: direct.database,
      ...direct.owner,
    });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ status: string }>(
        'select txid_status($1::bigint) as status',
        [xid],
      );
      return rows[0]?.status ?? 'missing';
    } finally {
      await admin.end();
    }
  };

  /**
   * Final review I1: PgBouncer trả `08P01 server conn crashed?` khi connection server chết lúc COMMIT đang bay. Proxy chuyển
   * COMMIT tới PgBouncer (commit thật sự bền), bỏ câu trả lời và gửi đúng ErrorResponse đó: client phải nhận
   * `commit_outcome_unknown`, không phải `service_unavailable` ("chắc chắn chưa ghi").
   */
  it('a PgBouncer 08P01 "server conn crashed?" during COMMIT is commit_outcome_unknown, and the commit did land', async () => {
    const t = await open();
    let xid = '';
    const r = await settle(() =>
      t.uow.run(async () => {
        const [row] = await t.db.execute<{ xid: string }>(
          'select txid_current()::text as xid',
        );
        xid = row?.xid ?? '';
        t.proxy.state.commit = 'pooler-crash';
      }),
    );
    if (r === 'hung' || r.err === undefined)
      throw new Error('expected a failure');
    expect(toAppError(r.err).error).toMatchObject({
      code: 'commit_outcome_unknown',
      status: 503,
    });
    expect(r.err).toMatchObject({
      opts: { cause: { code: '08P01', message: 'server conn crashed?' } },
    });
    expect(await txStatus(xid)).toBe('committed');
    t.proxy.state.commit = 'pass';
    await expect(t.db.execute('select 1 as ok')).resolves.toEqual([{ ok: 1 }]);
  });

  it('RelayDb.transaction: a pooler 08P01 during COMMIT is commit_outcome_unknown', async () => {
    await open('worker', { relay: true });
    if (!app || !relayProxy) throw new Error('app is not open');
    const relayDb = app.get(RelayDb);
    const cut = relayProxy;
    const r = await settle(() =>
      relayDb.transaction(async (tx) => {
        await tx.execute('select 1');
        cut.state.commit = 'pooler-crash';
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
