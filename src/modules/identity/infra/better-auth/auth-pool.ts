import { Logger } from '@nestjs/common';
import pg from 'pg';
import { type ConfigOf } from '../../../../core/config/index.js';
import {
  destroyUnusableClients,
  tlsOptions,
  watchPoolCheckouts,
  type PoolCheckouts,
  type databaseConfig,
} from '../../../../core/database/index.js';
import { logPoolEvent } from '../../../../core/logging/index.js';
import type { AuthDatabaseConfig } from '../../identity.config.js';
import { safeErrorFields } from '../../identity-telemetry.js';

const logger = new Logger('AuthPool');
/** Tên pool trong log của core (`db_pool_client_destroyed`, `db_pool_checkout_connection_lost`). */
export const AUTH_POOL_LABEL = 'auth';

/** Pool auth cùng bộ theo dõi checkout của nó (để tắt máy trả các checkout bị bỏ rơi, như `CorePoolShutdown`). */
export type AuthPoolHandle = { pool: pg.Pool; checkouts: PoolCheckouts };

/**
 * Pool `pg` riêng của Better Auth, không có hạn giữ checkout: CLI `auth` và test mở pool trực tiếp. App đi qua
 * `openAuthPool` (provider `AUTH_POOL`).
 */
export function createAuthPool(
  auth: AuthDatabaseConfig,
  db: ConfigOf<typeof databaseConfig>,
): pg.Pool {
  return openAuthPool(auth, db).pool;
}

/**
 * Pool `pg` riêng của Better Auth, đăng nhập `auth_user` (schema `auth` qua `search_path` của role). Không
 * đặt `statement_timeout` qua startup parameter (PgBouncer transaction mode bỏ đi); timeout nằm trên role.
 * `connectionTimeoutMillis`: hết chờ connection thì lỗi, được map thành 503 (spec §5.5 quy tắc 4).
 *
 * `holdDeadlineMs` (parity với pool core của api, S2-R60 round 6): checkout giữ quá mức này bị thu hồi. Kysely 0.29.6
 * không trả connection khi `BEGIN` lỗi (kysely.js:716-717) hay khi `COMMIT`/`ROLLBACK` quá hạn trên mạng blackhole mà
 * socket không chết (không có 'end'/'error' nào tới trước TCP timeout của kernel), nên slot mất tới lúc đó; bộ thu hồi
 * trả nó về pool kèm lỗi (pg-pool huỷ client).
 */
export function openAuthPool(
  auth: AuthDatabaseConfig,
  db: ConfigOf<typeof databaseConfig>,
  holdDeadlineMs?: number,
): AuthPoolHandle {
  if (!auth.password)
    throw new Error('DB_AUTH_PASSWORD is required to open the auth_user pool');
  const pool = new pg.Pool({
    host: auth.host ?? db.host,
    port: auth.port ?? db.port,
    database: db.name,
    user: auth.user,
    password: auth.password,
    max: auth.poolMax,
    connectionTimeoutMillis: auth.connectionTimeoutMs,
    // S2-R60: hạn phía client cho MỌI query của pool (pg đọc `connectionParameters.query_timeout` trong
    // `Client.query`, client.js:702): Kysely/Better Auth, transaction tự viết, probe. Hết hạn thì query reject
    // `Query read timeout` (→ 503, `isAuthInfraError`). Cần vì `connectionTimeoutMillis` chỉ chặn lúc kết nối và
    // `statement_timeout` của role nằm phía server: mạng blackhole thì không cái nào chạy.
    query_timeout: auth.queryTimeoutMs,
    ssl: tlsOptions(db),
  });
  // Review NB1: client RẢNH bị đứt (PgBouncer restart, pg_terminate_backend, mạng) làm pool phát 'error';
  // không có listener là uncaught exception → sập process. Cùng mẫu listener 'error' của SP1 (redis.module.ts).
  // Chỉ log mã lỗi (không message/host/user, kể cả trong câu log); pool tự bỏ client hỏng, request sau mở connection mới hoặc
  // lỗi → 503 ở mount (fail-closed). Không ném lại.
  pool.on('error', (err: Error & { code?: string }) =>
    logPoolEvent(
      logger,
      { event: 'auth_pool_idle_error', code: err.code, name: err.name },
      'idle auth pool connection failed; dropped from the pool',
    ),
  );
  // S2-R32 (bắt buộc, không thay thế được): listener 'error' PERMANENT trên MỌI client vật lý, từ 'connect' tới khi client
  // bị huỷ. pg-pool phát 'connect' đúng một lần cho mỗi client mới, trước lần giao đầu tiên (index.js:337, trước :344 gỡ
  // idleListener). Không cơ chế nào khác phủ trọn đời client: `watchPoolCheckouts` chỉ nghe từ 'acquire' tới 'release'
  // (và `once`), còn idleListener của pg-pool TỰ GỠ ở lỗi đầu tiên (index.js:55). Sau khi client bị trả kèm lỗi (thu hồi
  // của `watchPoolCheckouts`, probe quá hạn) và pg-pool `_remove`/`end()` nó, connection còn phát 'error' lần hai (handler
  // 'end' → `Connection terminated unexpectedly`, client.js:204-222): thiếu listener này là uncaught exception, sập
  // process (chaos "auth DB cut mid-query" đã bắt được đúng ca này khi listener bị bỏ ở một bản nháp của S2-R70).
  // Không ném lại; chỉ log mã lỗi (không message/host/user). Promise của query (nếu có) tự reject tới caller.
  pool.on('connect', (client) => {
    client.on('error', (err: Error & { code?: string }) =>
      logPoolEvent(
        logger,
        { event: 'auth_pool_client_error', code: err.code, name: err.name },
        'auth pool client connection failed; query rejection still reaches the caller',
      ),
    );
  });
  // S2-R70: một cơ chế cho mỗi việc, dùng chung với các pool core (`src/core/database/pool-checkouts.ts`). Thứ tự đăng ký
  // là một phần của hợp đồng: listener 'release' của `watchPoolCheckouts` phải chạy TRƯỚC `destroyUnusableClients`, để
  // gỡ listener 'end'/'error' của lần mượn trước khi `client.end()` làm connection phát 'end' (không thì 'end' đó bị hiểu
  // là "connection của client đang mượn đã chết").
  //
  // | Việc | Cơ chế |
  // |---|---|
  // | Không để 'error' của connection thành uncaught exception, suốt đời client (S2-R32) | listener permanent ở 'connect' ở trên |
  // | Client RẢNH đứt (PgBouncer restart, terminate, mạng): bỏ khỏi pool | idleListener của pg-pool + `pool.on('error')` ở trên (review NB1, log) |
  // | Client ĐANG MƯỢN mà connection chết: trả slot về pool (S2-R70 I1) | `watchPoolCheckouts`: nghe 'error'/'end' từ 'acquire' tới 'release', trả client về pool kèm lỗi thay người mượn, `release` của người mượn thành no-op |
  // | Client được trả KHÔNG kèm lỗi nhưng không dùng lại được (query quá hạn `query_timeout` còn treo — S2-R60; trả giữa transaction — review M3) | `destroyUnusableClients` (`clientDestroyReason`): `end()` client; client trả ngay sau một lỗi SQL, trước ReadyForQuery, được giữ (S2-R67 M1) |
  // | Client được trả KÈM lỗi | pg-pool tự bỏ và `end()` (index.js:392); `logErroredReleases` chỉ log lý do (review S2-R60 M1) |
  // | Client ĐANG MƯỢN quá `holdDeadlineMs` (BEGIN lỗi, COMMIT/ROLLBACK quá hạn trên blackhole: kysely không trả slot) | bộ thu hồi của `watchPoolCheckouts` |
  // | Tắt máy mà checkout còn bị giữ (`pool.end()` chờ mãi) | `AuthPoolLifecycle`: `checkouts.releaseAll` như `CorePoolShutdown` |
  const checkouts = watchPoolCheckouts(pool, {
    label: AUTH_POOL_LABEL,
    holdDeadlineMs,
  });
  destroyUnusableClients(pool, AUTH_POOL_LABEL);
  logErroredReleases(pool);
  return { pool, checkouts };
}

/**
 * Review S2-R60 M1: client trả kèm lỗi (mọi lỗi SQL của `pool.query`, probe quá hạn, ROLLBACK lỗi, connection chết lúc
 * đang mượn) bị pg-pool bỏ; `destroyUnusableClients` của core cố ý không log ca này. Ghi lý do thật bằng trường an toàn
 * (lớp + SQLSTATE/mã, không message) để on-call phân biệt 57014 do tranh lock với deadline phía client.
 *
 * S2-R73: tất cả log của listener cấp pool trong file này ('error' rảnh, 'error' của client, 'release' kèm lỗi) đi qua
 * `logPoolEvent` (không gọi `logger.warn` trực tiếp) — xem chú thích của hàm đó (`core/logging/pool-log.ts`) cho lý do.
 */
function logErroredReleases(pool: pg.Pool): void {
  pool.on('release', (err: unknown) => {
    if (!err) return;
    logPoolEvent(
      logger,
      {
        event: 'auth_pool_client_released_with_error',
        ...safeErrorFields(err),
      },
      'auth pool client released with an error; pg-pool drops it',
    );
  });
}
