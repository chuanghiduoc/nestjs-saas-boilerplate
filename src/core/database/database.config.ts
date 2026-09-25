import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';

export const databaseConfig = defineConfig(
  'database',
  {
    host: 'DB_HOST',
    port: 'DB_PORT',
    name: 'DB_NAME',
    appUser: 'DB_APP_USER',
    appPassword: 'DB_APP_PASSWORD',
    relayHost: 'DB_RELAY_HOST',
    relayPort: 'DB_RELAY_PORT',
    relayUser: 'DB_RELAY_USER',
    relayPassword: 'DB_RELAY_PASSWORD',
    ownerUser: 'DB_OWNER_USER',
    ownerPassword: 'DB_OWNER_PASSWORD',
    migrationHost: 'DB_MIGRATION_HOST',
    migrationPort: 'DB_MIGRATION_PORT',
    poolMax: 'DB_POOL_MAX',
    relayPoolMax: 'DB_RELAY_POOL_MAX',
    workerStatementTimeoutMs: 'DB_WORKER_STATEMENT_TIMEOUT_MS',
    migrationLockTimeoutMs: 'DB_MIGRATION_LOCK_TIMEOUT_MS',
    migrationStatementTimeoutMs: 'DB_MIGRATION_STATEMENT_TIMEOUT_MS',
    txRetryAttempts: 'DB_TX_RETRY_ATTEMPTS',
    txRetryBaseMs: 'DB_TX_RETRY_BASE_MS',
    sslMode: 'DB_SSL_MODE',
    sslCaPath: 'DB_SSL_CA_PATH',
    debug: 'DB_DEBUG',
  },
  z.object({
    host: z
      .string()
      .min(1)
      .describe('Host for the app connection (PgBouncer in production)'),
    port: z.coerce
      .number()
      .int()
      .positive()
      .default(5432)
      .describe('Port for the app connection'),
    name: z.string().min(1).describe('Database name'),
    appUser: z
      .string()
      .default('app_user')
      .describe('Role for api/worker business queries (RLS enforced)'),
    appPassword: z.string().min(1).describe('Password of app role'),
    relayHost: z
      .string()
      .optional()
      .describe(
        'Host for the relay connection (defaults to DB_HOST); worker only',
      ),
    relayPort: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('Port for the relay connection (defaults to DB_PORT)'),
    relayUser: z
      .string()
      .default('app_relay')
      .describe(
        'Role for outbox relay, cleanup, reconcile, metrics (no BYPASSRLS)',
      ),
    relayPassword: z
      .string()
      .optional()
      .describe('Password of relay role (required for worker)'),
    ownerUser: z
      .string()
      .default('app_owner')
      .describe('Role that owns tables and runs migrations'),
    ownerPassword: z
      .string()
      .optional()
      .describe('Password of owner role (required only for migrate)'),
    migrationHost: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Direct Postgres host for migrations, never PgBouncer (required only for migrate; no fallback to DB_HOST)',
      ),
    migrationPort: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Direct Postgres port for migrations (required only for migrate; no fallback to DB_PORT)',
      ),
    poolMax: z.coerce
      .number()
      .int()
      .positive()
      .default(10)
      .describe('Max app connections per process'),
    relayPoolMax: z.coerce
      .number()
      .int()
      .positive()
      .default(2)
      .describe('Max relay connections per worker'),
    workerStatementTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(60000)
      .describe(
        'statement_timeout applied with SET LOCAL in worker transactions (role default applies elsewhere)',
      ),
    migrationLockTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(5000)
      .describe('lock_timeout during migrations'),
    migrationStatementTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(600000)
      .describe('statement_timeout during migrations'),
    txRetryAttempts: z.coerce
      .number()
      .int()
      .min(0)
      .max(10)
      .default(3)
      .describe(
        'Retries for serialization failures/deadlocks (outermost transaction only)',
      ),
    txRetryBaseMs: z.coerce
      .number()
      .int()
      .positive()
      .default(20)
      .describe('Base delay for transaction retry backoff (full jitter)'),
    sslMode: z
      .enum(['disable', 'require', 'verify-full'])
      .default('disable')
      .describe('TLS to Postgres/PgBouncer'),
    sslCaPath: z.string().optional().describe('CA bundle path for verify-full'),
    debug: z.stringbool().default(false).describe('Log SQL (development only)'),
  }),
);

defineProductionRule('database-tls', (c) =>
  c.database?.sslMode === 'disable'
    ? 'DB_SSL_MODE must not be disable in production'
    : undefined,
);
defineProductionRule('database-no-debug', (c) =>
  c.database?.debug ? 'DB_DEBUG must be false in production' : undefined,
);
