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
  // Chỉ log mã lỗi (không message/host/user); pool tự bỏ client hỏng, request sau mở connection mới hoặc
  // lỗi → 503 ở mount (fail-closed). Không ném lại.
  pool.on('error', (err: Error & { code?: string }) =>
    logger.warn(
      { event: 'auth_pool_idle_error', code: err.code, name: err.name },
      'idle auth_user connection failed; dropped from the pool',
    ),
  );
  return pool;
}
