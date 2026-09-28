import { setTimeout as sleep } from 'node:timers/promises';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { getEntityManagerToken } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/postgresql';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ConfigOf } from '../../src/core/config/index.js';
import {
  DB_CONTEXT,
  DatabaseModule,
  Db,
  UnitOfWork,
  databaseConfig,
} from '../../src/core/database/index.js';
import { HealthModule } from '../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../src/core/http/index.js';
import { httpConfig } from '../../src/core/http/http.config.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { createTestApp } from '../support/app-factory.js';
import { getInfra } from '../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

/**
 * Tham số của bộ test (không phải config của app).
 * - `QUERY_TIMEOUT_MS`/`CONNECTION_TIMEOUT_MS`/`REQUEST_BUDGET_MS`: deadline của pool core (S2-R67) và ngân sách
 *   request (cũng là hạn thu hồi checkout bị bỏ rơi), nhỏ để test nhanh; bound latency đọc lại từ config của app.
 *   Ngân sách cách xa bound (8000 so với 500 + 2 x 1000 + margin): thiếu `query_timeout` thì chỉ bộ thu hồi cứu request
 *   ở mốc ngân sách, và test phải thấy rõ là vượt bound thay vì sát nút.
 * - `POOL_MAX`: đủ để loạt request trong blackhole vừa lấy hết client rảnh vừa phải xếp hàng chờ slot.
 * - `LATENCY_MARGIN_MS`: phần cộng thêm cho supertest và event loop.
 * - `HUNG_FACTOR`: quá `HUNG_FACTOR` lần bound thì coi là treo (thiếu deadline: query chờ TCP timeout của kernel).
 */
const QUERY_TIMEOUT_MS = 1000;
const CONNECTION_TIMEOUT_MS = 500;
const REQUEST_BUDGET_MS = 8000;
const POOL_MAX = 4;
const LATENCY_MARGIN_MS = 1500;
const HUNG_FACTOR = 3;
const WAIT = { timeout: 30_000, interval: 50 };

@Controller('chaos-db')
class CoreDbRoutes {
  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}
  /** Một query ngoài transaction (Kysely `executeQuery`, không ROLLBACK). */
  @Get('read') async read() {
    return { rows: await this.db.execute('select 1 as ok') };
  }
  /** Transaction của UnitOfWork: query kẹt thì ROLLBACK xếp hàng sau nó (đường xấu nhất của luật production). */
  @Get('tx') async tx() {
    return {
      rows: await this.uow.run(async () => {
        await this.db.execute('select 1');
        return this.db.execute('select 2 as ok');
      }),
    };
  }
  /** Giữ connection một lúc để làm ấm đủ POOL_MAX client vật lý. */
  @Get('warm') async warm() {
    await this.uow.run(() => this.db.execute('select pg_sleep(0.2)'));
    return {};
  }
}
@Module({ controllers: [CoreDbRoutes] })
class Routes {}

type Timed = { res: Response; ms: number };
const timed = async (fn: () => Promise<Response>): Promise<Timed> => {
  const t = performance.now();
  const res = await fn();
  return { res, ms: performance.now() - t };
};

/**
 * S2-R67: DB core bị blackhole (mất gói, không RST) trên một pool ẤM. Không có hạn phía client, route Nest chạm DB core
 * treo vô hạn — cả query trên socket đã mở lẫn việc lấy connection mới. Cần: mọi request trả 503 problem+json trong
 * bound (chờ connection + query quá hạn + ROLLBACK quá hạn), không bao giờ 500 hay treo; mạng lành thì pool tự phục hồi:
 * client quá hạn đã bị huỷ, slot của transaction mà Kysely không trả (ROLLBACK lỗi) được thu hồi trong ngân sách request.
 *
 * Proxy TCP trong process (`test/support/tcp-proxy.ts`): `blackhole` bỏ mọi byte theo cả hai chiều trên connection
 * đang mở lẫn connection mới, không đóng socket.
 */
describe('core DB blackholed on a warm pool (S2-R67)', () => {
  let app: INestApplication;
  let proxy: TcpProxy;
  let base = '';
  let boundMs = 0;
  let reapMs = 0;
  const crashes: { kind: string; err: unknown }[] = [];
  const onUncaught = (err: unknown) =>
    crashes.push({ kind: 'uncaughtException', err });
  const onUnhandled = (err: unknown) =>
    crashes.push({ kind: 'unhandledRejection', err });

  const pool = (): Promise<pg.Pool> =>
    app
      .get<EntityManager>(getEntityManagerToken(DB_CONTEXT.app))
      .getConnection()
      .getNativeClient();
  const get = (path: string) => request(base).get(path);

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_PORT', String(proxy.port));
    vi.stubEnv('DB_POOL_MAX', String(POOL_MAX));
    vi.stubEnv('DB_QUERY_TIMEOUT_MS', String(QUERY_TIMEOUT_MS));
    vi.stubEnv('DB_CONNECTION_TIMEOUT_MS', String(CONNECTION_TIMEOUT_MS));
    vi.stubEnv('HTTP_REQUEST_BUDGET_MS', String(REQUEST_BUDGET_MS));
    // Loạt request của test đi từ một IP; không để throttler trả 429 thay cho câu trả lời thật.
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', '100000');
    app = await createTestApp(
      [
        DatabaseModule.forRoot({ relay: false }),
        RedisModule,
        HttpModule,
        HealthModule.forRoot({ http: true }),
        Routes,
      ],
      { beforeInit: applyHttpDefaults },
    );
    // Lắng nghe thật một lần: supertest trên server chưa listen mở một listener mỗi request.
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const db = app.get<ConfigOf<typeof databaseConfig>>(databaseConfig.KEY);
    const http = app.get<ConfigOf<typeof httpConfig>>(httpConfig.KEY);
    // Cùng công thức với luật production `database-query-deadline`.
    boundMs =
      db.connectionTimeoutMs + 2 * db.queryTimeoutMs + LATENCY_MARGIN_MS;
    reapMs = http.requestBudgetMs + LATENCY_MARGIN_MS;
  });
  afterAll(async () => {
    // Cắt socket trước khi đóng app: nếu deadline hỏng, query treo chỉ nhả client khi socket chết.
    await proxy?.close();
    await app?.close();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    vi.unstubAllEnvs();
  });

  it('Nest routes touching the core DB answer 503 within connect + query + ROLLBACK deadlines, never 500 or a hang; the pool recovers without stuck or leaked clients', async () => {
    const p = await pool();
    // Làm ấm: đủ POOL_MAX connection vật lý, rồi chắc chắn chúng RẢNH đúng lúc cắt mạng. Pool nguội thì mọi query đi
    // đường kết nối mới, `DB_CONNECTION_TIMEOUT_MS` trả 503 thay, test xanh mà không chạm socket đã mở.
    await Promise.all(
      Array.from({ length: POOL_MAX }, () => get('/chaos-db/warm').expect(200)),
    );
    await vi.waitFor(() => expect(p.totalCount - p.idleCount).toBe(0), WAIT);
    expect(p.idleCount).toBe(POOL_MAX);

    proxy.state.blackhole = true;
    try {
      const run = (path: string) =>
        Promise.race([
          timed(() => get(path)),
          sleep(boundMs * HUNG_FACTOR).then(() => 'hung' as const),
        ]);
      // Đợt 1: đúng POOL_MAX request, mỗi cái lấy một client RẢNH (socket đã mở, kẹt): nửa đọc ngoài transaction, nửa
      // transaction. Transaction kẹt ngay ở BEGIN, và Kysely 0.29.6 `ControlledTransactionBuilder.execute` không trả
      // connection khi BEGIN lỗi: slot đó chỉ quay về nhờ thu hồi checkout (nhánh ROLLBACK quá hạn nằm ở spec
      // integration `core-pool-deadline.spec.ts`, nơi mạng bị cắt sau BEGIN). Chờ tới khi cả pool bị giữ rồi mới bắn
      // đợt 2, để đợt 2 không giành client rảnh của đợt 1.
      const firstPaths = Array.from({ length: POOL_MAX }, (_, i) =>
        i % 2 === 0 ? '/chaos-db/read' : '/chaos-db/tx',
      );
      const first = firstPaths.map(run);
      await vi.waitFor(() => expect(p.idleCount).toBe(0), WAIT);
      // Đợt 2: pool đầy, chờ slot (hàng chờ pg-pool chỉ có hạn nhờ `connectionTimeoutMillis`) hoặc kết nối mới.
      const secondPaths = [...firstPaths];
      const results = await Promise.all([...first, ...secondPaths.map(run)]);
      const paths = [...firstPaths, ...secondPaths];
      for (const [i, t] of results.entries()) {
        const label = `blackholed #${i} ${paths[i]}`;
        expect(t, label).not.toBe('hung');
        if (t === 'hung') continue;
        expect(
          [
            t.res.status,
            t.res.body?.code,
            t.res.headers['content-type']?.includes('application/problem+json'),
          ],
          label,
        ).toEqual([503, 'service_unavailable', true]);
        expect(t.ms, `${label} latency`).toBeLessThanOrEqual(boundMs);
        // Đợt 1 phải thật sự đi qua socket kẹt (chờ hết một deadline query), không phải đường chờ slot/kết nối mới.
        if (i < POOL_MAX)
          expect(
            t.ms,
            `${label} took the stuck-socket path`,
          ).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS);
      }
    } finally {
      proxy.state.blackhole = false;
    }

    // Slot của transaction có ROLLBACK quá hạn không được Kysely trả; chúng phải quay về trong ngân sách request
    // (`reapAbandonedCheckouts`). Chờ bằng bộ đếm của pool, KHÔNG bằng `/health/ready`: probe readiness đi qua pool và
    // có thể dọn client kẹt hộ, che mất lỗi thiếu huỷ.
    await vi.waitFor(() => expect(p.totalCount - p.idleCount).toBe(0), {
      timeout: reapMs,
      interval: 50,
    });
    // Loạt gấp đôi pool đi qua mọi client rảnh: client nào quá hạn mà còn nằm trong pool sẽ làm request 503.
    const burst = await Promise.all(
      Array.from({ length: POOL_MAX * 2 }, (_, i) =>
        get(i % 2 === 0 ? '/chaos-db/read' : '/chaos-db/tx'),
      ),
    );
    expect(burst.map((b) => b.status)).toEqual(Array(POOL_MAX * 2).fill(200));
    expect((await get('/health/ready')).status).toBe(200);
    await vi.waitFor(() => {
      expect(p.waitingCount).toBe(0);
      expect(p.totalCount - p.idleCount).toBe(0);
    }, WAIT);
    expect(p.totalCount).toBeLessThanOrEqual(POOL_MAX);
    expect(crashes).toEqual([]);
  });
});
