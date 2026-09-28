import { Logger } from '@nestjs/common';
import pg from 'pg';
import { type ConfigOf } from '../../../../core/config/index.js';
import {
  tlsOptions,
  type databaseConfig,
} from '../../../../core/database/index.js';
import type { AuthDatabaseConfig } from '../../identity.config.js';
import { safeErrorFields } from '../../identity-telemetry.js';

const logger = new Logger('AuthPool');

/**
 * Pool `pg` riêng của Better Auth, đăng nhập `auth_user` (schema `auth` qua `search_path` của role). Không
 * đặt `statement_timeout` qua startup parameter (PgBouncer transaction mode bỏ đi); timeout nằm trên role.
 * `connectionTimeoutMillis`: hết chờ connection thì lỗi, được map thành 503 (spec §5.5 quy tắc 4).
 */
export function createAuthPool(
  auth: AuthDatabaseConfig,
  db: ConfigOf<typeof databaseConfig>,
): pg.Pool {
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
    logger.warn(
      { event: 'auth_pool_idle_error', code: err.code, name: err.name },
      'idle auth pool connection failed; dropped from the pool',
    ),
  );
  // S2-R32: pg-pool gỡ listener 'error' rảnh của nó ngay khi giao client cho caller (`_acquireClient`,
  // pg-pool/index.js:344) và chỉ gắn lại trong `release()` (dòng 385) — khoảng đó client KHÔNG có listener
  // 'error' nào, trừ khi caller tự gắn (như `auth-readiness.ts` làm cho probe). Kysely's `PostgresDriver`
  // (postgres-driver.js) checkout bằng `pool.connect()` và không gắn gì: socket chết giữa query thì pg phát
  // 'error' đồng bộ trên client (client.js, handler 'end' → `_handleErrorEvent`) — không listener là uncaught
  // exception, sập process, bất kể promise của query có bị reject riêng và bắt được hay không.
  // pg-pool phát 'connect' đúng một lần cho mỗi client VẬT LÝ mới, ngay sau khi kết nối xong và TRƯỚC lần
  // giao đầu tiên (pg-pool/index.js: `newClient` → callback của `client.connect()` → `_afterConnect` →
  // `_acquireClient` dòng 337 `this.emit('connect', client)`, trước dòng 344 gỡ idleListener). Gắn listener
  // permanent ở đây cho mọi client vật lý, phủ toàn bộ đời client (rảnh hay đang checkout) — không phụ thuộc
  // caller có tự gắn hay không, che luôn Kysely và mọi consumer tương lai của pool này.
  // Không ném lại; chỉ log mã lỗi (không message/host/user). Promise của query (nếu có) tự reject tới caller.
  pool.on('connect', (client) => {
    client.on('error', (err: Error & { code?: string }) =>
      logger.warn(
        { event: 'auth_pool_client_error', code: err.code, name: err.name },
        'auth pool client failed while checked out; query rejection still reaches the caller',
      ),
    );
  });
  // S2-R60: pg 8.23 KHÔNG huỷ client khi `query_timeout` hết (non-pipeline, client.js:706-731): nó reject promise
  // nhưng query vẫn là query đang chạy, `readyForQuery` vẫn `false`. Kysely (`releaseConnection`) và caller thường
  // `release()` không kèm lỗi, nên pg-pool trả client đó về pool; query sau xếp hàng sau query không bao giờ xong
  // (mạng blackhole) và cũng quá hạn — client bị đầu độc vĩnh viễn. pg-pool phát 'release' ĐỒNG BỘ trước khi quyết
  // định giữ hay bỏ client (pg-pool/index.js:389, rồi dòng 392 bỏ client khi `err` hoặc `client._ending`);
  // `client.end()` đặt `_ending` đồng bộ và huỷ socket ngay khi còn query đang chạy (client.js:782,804-806).
  // Luật (`destroyReason`): client chỉ về pool khi release KHÔNG kèm lỗi, nó báo sẵn sàng nhận query mới VÀ không
  // còn transaction mở; mọi trường hợp khác bị huỷ — fail-closed, cái giá xấu nhất là mở connection mới. Phủ mọi
  // consumer (Kysely, `pool.connect()`, `pool.query()`) mà không bọc query hay dùng pipeline mode.
  pool.on('release', (err: unknown, client) => {
    const reason = destroyReason(err, client);
    if (reason === undefined) return;
    logger.warn(
      {
        event: 'auth_pool_client_destroyed',
        reason,
        ...(err ? safeErrorFields(err) : {}),
      },
      'auth pool client destroyed instead of returning to the pool',
    );
    // Review M1: release kèm lỗi thì CHÍNH pg-pool bỏ và `end()` client (index.js:392 → `_remove`): không end lần hai.
    // Còn lại: `end()` không bao giờ reject (resolve ở 'end' của connection); `_remove` gọi lại `end(cb)` an toàn.
    if (reason !== 'released_with_error') void client.end();
  });
  return pool;
}

type DestroyReason =
  'released_with_error' | 'not_ready_for_query' | 'open_transaction';

/**
 * Vì sao client KHÔNG được về pool (`undefined` = về pool).
 * - `released_with_error`: caller trả kèm lỗi (`pool.query` với mọi lỗi SQL, probe quá hạn); pg-pool tự bỏ.
 * - `not_ready_for_query`: `readyForQuery !== true` (trường không nằm trong type của pg; vắng mặt cũng coi là chưa
 *   sẵn sàng). Hai nguồn: query quá hạn `query_timeout` còn treo (S2-R60), hoặc (review M2) đường lỗi của Kysely khi
 *   ErrorResponse và ReadyForQuery tới trong HAI lần đọc socket khác nhau (TLS, PgBouncer, máy bận): promise reject
 *   ở ErrorResponse, Kysely release trong microtask trước khi ReadyForQuery tới. Không phân biệt được hai nguồn bằng
 *   API công khai, nên cả hai đều bị huỷ: ca sau chỉ tốn một lần kết nối lại cho mỗi lỗi SQL bị ảnh hưởng (chưa thấy
 *   trên loopback), còn giữ lại một client đang treo thì đầu độc pool.
 * - `open_transaction`: review M3, `getTransactionStatus()` (pg client.js:777, `_txStatus` từ ReadyForQuery) khác
 *   `'I'`: caller trả client giữa transaction (`T`) hoặc transaction đã hỏng (`E`) mà không ROLLBACK. Trả về pool thì
 *   người mượn sau nhận 25P02 hoặc thừa hưởng lock.
 */
function destroyReason(
  err: unknown,
  client: pg.PoolClient,
): DestroyReason | undefined {
  if (err) return 'released_with_error';
  const ready = 'readyForQuery' in client ? client.readyForQuery : undefined;
  if (ready !== true) return 'not_ready_for_query';
  if (client.getTransactionStatus() !== 'I') return 'open_transaction';
  return undefined;
}
