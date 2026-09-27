import { Logger } from '@nestjs/common';
import pg from 'pg';
import { type ConfigOf } from '../../../../core/config/index.js';
import {
  tlsOptions,
  type databaseConfig,
} from '../../../../core/database/index.js';
import type { AuthDatabaseConfig } from '../../identity.config.js';

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
  return pool;
}
