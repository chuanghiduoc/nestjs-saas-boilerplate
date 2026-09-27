import { betterAuth } from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import '../../../../core/config/all-configs.js';
import { appConfig } from '../../../../core/config/index.js';
import { databaseConfig } from '../../../../core/database/index.js';
import {
  authDatabaseConfig,
  identityConfig,
  identityGuardConfig,
} from '../../identity.config.js';
import { createAuthPool } from './auth-pool.js';
import { AUTH_SCHEMA, schemaOptions } from './auth-schema.js';

/**
 * CHỈ cho CLI `auth` (spec §5.3 bước 1): dạng `{ db, type, schemaName, transaction }` vì CLI cần dialect,
 * không cần lớp mã hoá của runtime. Plugin lấy từ `schemaOptions`, cùng nguồn với runtime.
 * Chạy từ `dist/` (script `auth:*`) để import `.js` resolve bằng Node, không phụ thuộc jiti.
 */

/**
 * CLI `auth` 1.7.6 nuốt mọi lỗi nạp config (`catch {}` rồi chỉ in "Could not load the Better Auth configuration.",
 * `auth/dist/index.mjs`), nên thiếu env thì không biết thiếu biến nào (review M2). In lỗi ra stderr trước khi ném lại.
 * An toàn: lỗi ở đây chỉ đến từ config của mình, `ConfigValidationError` nêu tên env + thông điệp zod, không có giá trị.
 */
function loadOrExplain<T>(what: string, load: () => T): T {
  try {
    return load();
  } catch (err) {
    process.stderr.write(
      `auth.cli-config: cannot load ${what}: ${err instanceof Error ? `${err.name}: ${err.message}` : typeof err}\n`,
    );
    throw err;
  }
}

const identity = loadOrExplain('identity config', () => identityConfig());
const pool = loadOrExplain('auth_user pool', () =>
  createAuthPool(authDatabaseConfig(), databaseConfig()),
);
const app = loadOrExplain('app config', () => appConfig());
const guard = loadOrExplain('identity guard config', () =>
  identityGuardConfig(),
);
const options = loadOrExplain('plugin options', () =>
  schemaOptions(identity, app, guard),
);
export const auth = betterAuth({
  secret: identity.secret,
  baseURL: identity.baseUrl,
  database: {
    db: new Kysely({
      dialect: new PostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()],
    }),
    type: 'postgres',
    schemaName: AUTH_SCHEMA,
    transaction: true,
  },
  ...options,
});
export default auth;
