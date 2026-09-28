import { Logger } from '@nestjs/common';
import type pg from 'pg';
import type { ConfigOf, appConfig } from '../config/index.js';
import type { httpConfig } from '../http/http.config.js';
import type { databaseConfig } from './database.config.js';

const logger = new Logger('CorePool');

type CorePoolOptions = Pick<
  pg.PoolConfig,
  'connectionTimeoutMillis' | 'query_timeout'
> & {
  /** Tách ra và gọi với pool vừa tạo, SAU `handlePoolErrors` của MikroORM (PostgreSqlConnection.js:10-15). */
  onPoolCreated: (pool: pg.Pool) => void;
};

/**
 * S2-R67: phần `driverOptions` của pool core theo vai trò process.
 *
 * api: request HTTP có ngân sách thời gian (`HTTP_REQUEST_BUDGET_MS`), và mọi query api đã bị role `app_user` chặn ở
 * `statement_timeout` (compose mặc định 5000 ms), nên deadline cao hơn mức đó không cắt query thật nào.
 * - `connectionTimeoutMillis`: chặn cả chờ slot pool (pg-pool index.js:206-226; không có nó hàng chờ vô hạn) lẫn kết
 *   nối mới (:250-262).
 * - `query_timeout`: chặn từng query trên socket đã mở (pg client.js:702).
 * - Thu hồi checkout bị bỏ rơi (`reapAbandonedCheckouts`).
 *
 * worker/migrate: không có hạn phía client. Job chạy dưới `SET LOCAL statement_timeout` = DB_WORKER_STATEMENT_TIMEOUT_MS
 * (60 s), relay dưới `statement_timeout` của role app_relay, và `connectionTimeoutMillis` vừa chặn kết nối mới vừa chặn
 * chờ slot — áp vào worker làm job fail khi pool bận chứ không chỉ khi DB chết. Migration không đi qua đây
 * (`runMigrations` tự mở MikroORM riêng). Chốt huỷ client kẹt (`destroyStuckClients`) áp cho mọi vai trò.
 */
export function corePoolOptions(
  db: ConfigOf<typeof databaseConfig>,
  http: ConfigOf<typeof httpConfig>,
  role: ConfigOf<typeof appConfig>['role'],
): CorePoolOptions {
  switch (role) {
    case 'api':
      return {
        connectionTimeoutMillis: db.connectionTimeoutMs,
        query_timeout: db.queryTimeoutMs,
        onPoolCreated: (pool) => {
          destroyStuckClients(pool);
          reapAbandonedCheckouts(pool, http.requestBudgetMs);
        },
      };
    case 'worker':
    case 'migrate':
      return { onPoolCreated: destroyStuckClients };
    default: {
      const unknown: never = role;
      throw new Error(`Unknown APP_ROLE "${String(unknown)}"`);
    }
  }
}

/**
 * S2-R67 (cùng cơ chế S2-R60 của pool `auth_user`): pg 8.23 KHÔNG huỷ client khi `query_timeout` hết (non-pipeline,
 * client.js:706-731): nó reject promise nhưng query vẫn là query đang chạy, `readyForQuery` vẫn `false`. Kysely của
 * MikroORM `release()` không kèm lỗi, nên pg-pool trả client đó về pool; query sau xếp hàng sau query không bao giờ xong
 * (mạng blackhole) và cũng quá hạn — client bị đầu độc vĩnh viễn. pg-pool phát 'release' ĐỒNG BỘ trước khi quyết định
 * giữ hay bỏ client (pg-pool/index.js:389, rồi :392 bỏ client khi `err` hoặc `client._ending`); `client.end()` đặt
 * `_ending` đồng bộ và huỷ socket ngay khi còn query đang chạy (client.js:782,804-806).
 *
 * Client chỉ được về pool khi nó sẵn sàng nhận query mới VÀ không còn transaction mở (`getTransactionStatus() === 'I'`,
 * review S2-R60 M3: client trả giữa transaction sẽ đưa 25P02/lock cho người mượn sau). Có `err` thì pg-pool tự bỏ
 * client (review M1: không đếm trùng, không log sai lý do). Fail-closed: cái giá xấu nhất là mở connection mới; kể cả
 * khi ErrorResponse và ReadyForQuery tới ở hai lần đọc socket (TLS/PgBouncer) và Kysely trả client giữa hai lần đó
 * (review M2: một lần kết nối lại cho lỗi SQL đó).
 */
export function destroyStuckClients(pool: pg.Pool): void {
  pool.on('release', (err, client) => {
    if (err) return;
    const ready = 'readyForQuery' in client ? client.readyForQuery : undefined;
    const txStatus = client.getTransactionStatus();
    if (ready === true && txStatus === 'I') return;
    logger.warn(
      {
        event: 'core_pool_client_destroyed',
        reason: ready === true ? 'transaction_open' : 'query_in_flight',
      },
      'core pool client released while not idle (query deadline or open transaction); destroying it',
    );
    // `end()` không bao giờ reject (resolve ở 'end' của connection); pg-pool `_remove` gọi lại `end(cb)` an toàn.
    void client.end();
  });
}

/**
 * S2-R67: Kysely 0.29.6 `ControlledTransaction` (MikroORM `transactional` dùng `startTransaction()`) chỉ trả connection
 * SAU KHI `ROLLBACK`/`COMMIT` thành công (kysely.js:775-777, :807-809), và `ControlledTransactionBuilder.execute` không
 * trả khi `BEGIN` lỗi (:716-717). Trên mạng blackhole BEGIN quá hạn, hoặc ROLLBACK xếp hàng sau query kẹt và cũng quá
 * hạn, nên client không bao giờ được trả: slot pool mất vĩnh viễn, và sau `DB_POOL_MAX` transaction như vậy api trả 503
 * mãi kể cả khi DB đã lành (cũng vậy khi connection bị reset giữa transaction: ROLLBACK lỗi ngay). Luật
 * `database-query-deadline` giữ đường query + ROLLBACK dưới ngân sách, nên bộ thu hồi không bao giờ đi trước nó. Trong api, không checkout nào hợp lệ sống quá ngân sách một request HTTP
 * (proxy phía trước đã trả lời thay), nên checkout quá `HTTP_REQUEST_BUDGET_MS` bị thu hồi: trả slot kèm lỗi (pg-pool
 * bỏ và huỷ client, :392), rồi `release` của người giữ thành no-op để lần trả muộn (nếu có) không ném "Release called
 * on client which has already been released". Query còn chạy trên client đó nhận `Connection terminated`, query sau nhận
 * `Client was closed and is not queryable` (đều → 503, `dbErrorMapper`).
 */
export function reapAbandonedCheckouts(
  pool: pg.Pool,
  deadlineMs: number,
): void {
  const timers = new WeakMap<pg.PoolClient, NodeJS.Timeout>();
  pool.on('acquire', (client) => {
    const timer = setTimeout(() => {
      timers.delete(client);
      logger.warn(
        { event: 'core_pool_checkout_reaped', deadlineMs },
        'core pool connection held past the HTTP request budget; destroying it and returning its slot',
      );
      client.release(
        new Error(`core pool checkout held longer than ${deadlineMs} ms`),
      );
      client.release = () => undefined;
    }, deadlineMs);
    // Không giữ process sống chỉ vì timer này (shutdown đóng pool riêng).
    timer.unref();
    timers.set(client, timer);
  });
  pool.on('release', (_err, client) => {
    clearTimeout(timers.get(client));
    timers.delete(client);
  });
}
