import type pg from 'pg';
import type { ConfigOf, appConfig } from '../config/index.js';
import type { httpConfig } from '../http/http.config.js';
import type { databaseConfig } from './database.config.js';
import {
  destroyUnusableClients,
  watchPoolCheckouts,
  type PoolCheckouts,
} from './pool-checkouts.js';

/**
 * `driverOptions` của pool core. MikroORM 7.2.1 gõ `driverOptions` là `Dictionary` và không khai `onPoolCreated` trong
 * `.d.ts`; `PostgreSqlConnection.createKyselyDialect` (PostgreSqlConnection.js:9-16) tách `onPoolCreated` ra, trộn phần
 * còn lại vào options của `new Pool(...)`, chạy `handlePoolErrors(pool)` rồi mới gọi `onPoolCreated(pool)`, đồng bộ, trước
 * lần checkout đầu. Kiểu cục bộ này giữ cả hai phần được kiểm (không ép kiểu); hook vắng mặt ở bản MikroORM sau sẽ làm
 * test `listenerCount` của spec integration đỏ.
 */
export type CoreDriverOptions = pg.PoolConfig & {
  onPoolCreated: (pool: pg.Pool) => void;
};

type Role = ConfigOf<typeof appConfig>['role'];

/**
 * S2-R67 / S2-R70: phần pool của `driverOptions` theo vai trò process.
 *
 * - api: `connectionTimeoutMillis` = DB_CONNECTION_TIMEOUT_MS (chặn cả chờ slot, pg-pool index.js:206-226, lẫn kết nối
 *   mới, :250-262), `query_timeout` = DB_QUERY_TIMEOUT_MS (pg client.js:702), và bộ thu hồi checkout giữ quá
 *   `HTTP_REQUEST_BUDGET_MS` (dự phòng: blackhole làm BEGIN/ROLLBACK quá hạn mà socket không chết, kysely không trả slot).
 * - worker: DB_WORKER_CONNECTION_TIMEOUT_MS / DB_WORKER_QUERY_TIMEOUT_MS, trên `statement_timeout` 60 s của job; không
 *   thu hồi theo thời gian (job hợp lệ giữ connection lâu).
 * - Mọi vai trò (cả `migrate`, dù `runMigrations` tự mở MikroORM riêng và không đi qua đây): huỷ client không dùng lại
 *   được, và trả slot khi connection của client đang mượn chết.
 */
export function corePoolOptions(
  db: ConfigOf<typeof databaseConfig>,
  http: ConfigOf<typeof httpConfig>,
  role: Role,
  label: string,
  onWatched: (checkouts: PoolCheckouts) => void,
): Omit<CoreDriverOptions, 'ssl'> {
  const guard =
    (holdDeadlineMs?: number) =>
    (pool: pg.Pool): void => {
      onWatched(watchPoolCheckouts(pool, { label, holdDeadlineMs }));
      destroyUnusableClients(pool, label);
    };
  switch (role) {
    case 'api':
      return {
        connectionTimeoutMillis: db.connectionTimeoutMs,
        query_timeout: db.queryTimeoutMs,
        onPoolCreated: guard(http.requestBudgetMs),
      };
    case 'worker':
      return {
        connectionTimeoutMillis: db.workerConnectionTimeoutMs,
        query_timeout: db.workerQueryTimeoutMs,
        onPoolCreated: guard(),
      };
    case 'migrate':
      return { onPoolCreated: guard() };
    default: {
      const unknown: never = role;
      throw new Error(`Unknown APP_ROLE "${String(unknown)}"`);
    }
  }
}
