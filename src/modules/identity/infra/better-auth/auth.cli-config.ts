import { betterAuth } from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import '../../../../core/config/all-configs.js';
import { appConfig } from '../../../../core/config/index.js';
import { databaseConfig } from '../../../../core/database/index.js';
import { authDatabaseConfig, identityConfig } from '../../identity.config.js';
import { createAuthPool } from './auth-pool.js';
import { AUTH_SCHEMA, schemaOptions } from './auth-schema.js';

/**
 * CHỈ cho CLI `auth` (spec §5.3 bước 1): dạng `{ db, type, schemaName, transaction }` vì CLI cần dialect,
 * không cần lớp mã hoá của runtime. Plugin lấy từ `schemaOptions`, cùng nguồn với runtime.
 * Chạy từ `dist/` (script `auth:*`) để import `.js` resolve bằng Node, không phụ thuộc jiti.
 */
const identity = identityConfig();
const pool = createAuthPool(authDatabaseConfig(), databaseConfig());
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
  ...schemaOptions(identity, appConfig()),
});
export default auth;
