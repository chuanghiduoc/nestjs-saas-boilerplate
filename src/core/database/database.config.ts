import { z } from 'zod';
import {
  defineConfig,
  defineConfigRule,
  defineProductionRule,
  secretMeta,
} from '../config/index.js';

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
    connectionTimeoutMs: 'DB_CONNECTION_TIMEOUT_MS',
    queryTimeoutMs: 'DB_QUERY_TIMEOUT_MS',
    workerConnectionTimeoutMs: 'DB_WORKER_CONNECTION_TIMEOUT_MS',
    workerQueryTimeoutMs: 'DB_WORKER_QUERY_TIMEOUT_MS',
    workerCheckoutMaxMs: 'DB_WORKER_CHECKOUT_MAX_MS',
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
    appPassword: z
      .string()
      .optional()
      .transform((s) => (s ? s : undefined))
      .describe(
        'Password of app role; required on api and worker (rule database-app-password-required)',
      )
      .meta(secretMeta(['api', 'worker'])),
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
      .describe('Password of relay role (required for worker)')
      .meta(secretMeta(['worker'])),
    ownerUser: z
      .string()
      .default('app_owner')
      .describe('Role that owns tables and runs migrations'),
    ownerPassword: z
      .string()
      .optional()
      .describe('Password of owner role (required only for migrate)')
      .meta(secretMeta(['migrate'])),
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
    connectionTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(3000)
      .describe(
        'api process (APP_ROLE=api): max wait for a core pool connection, both a free pool slot and a new connection (pg connectionTimeoutMillis); past it the request fails as 503. The worker uses DB_WORKER_CONNECTION_TIMEOUT_MS',
      ),
    queryTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(6000)
      .describe(
        'api process (APP_ROLE=api): client-side deadline of every query on the core pool (pg query_timeout); a query past it fails as 503 and its connection is destroyed, never reused. Set it ABOVE the app_user role statement_timeout (DB_APP_STATEMENT_TIMEOUT_MS, compose default 5000) so a slow query is cancelled server-side first and keeps its connection; this deadline only fires when the server cannot answer at all (network blackhole). Production: DB_CONNECTION_TIMEOUT_MS + 2 x DB_QUERY_TIMEOUT_MS must be below HTTP_REQUEST_BUDGET_MS (rule database-query-deadline). Checked at readiness against the real app_user statement_timeout (0 or >= this fails in production)',
      ),
    workerQueryTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(65_000)
      .describe(
        'worker process (APP_ROLE=worker): client-side deadline of every query on the core app and relay pools (pg query_timeout); a query past it fails and its connection is destroyed, never reused. Must be above DB_WORKER_STATEMENT_TIMEOUT_MS (rule database-worker-query-deadline) and above the app_relay role statement_timeout (DB_RELAY_STATEMENT_TIMEOUT_MS, compose default 60000; checked at readiness, 0 or >= this fails in production), so the deadline only fires when the server cannot answer at all',
      ),
    workerCheckoutMaxMs: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000)
      .describe(
        'worker process (APP_ROLE=worker): the longest a job may hold one core app/relay pool connection (one transaction, or one statement outside a transaction). A connection held longer is destroyed and its pool slot returned: on a blackholed network a timed-out BEGIN/ROLLBACK is never released by the query builder, and without this the slot stays lost until the kernel TCP timeout (about 15 min). Jobs register no per-job timeout, so this key is the declared maximum; a job transaction must finish well below it. Must be above 2 x DB_WORKER_QUERY_TIMEOUT_MS (rule database-worker-checkout-max: a stuck statement plus the ROLLBACK queued behind it are answered by the query deadline first)',
      ),
    workerConnectionTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(65_000)
      .describe(
        'worker process (APP_ROLE=worker): max wait for a core app/relay pool connection, both a free pool slot and a new connection (pg connectionTimeoutMillis); past it the job fails and BullMQ retries it with backoff. At least DB_WORKER_QUERY_TIMEOUT_MS (rule database-worker-connection-wait), so a busy but healthy pool (a slot held by one legitimate long statement) does not fail jobs',
      ),
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
      .describe(
        'TLS to Postgres/PgBouncer: require encrypts without verifying the certificate; production requires verify-full',
      ),
    sslCaPath: z.string().optional().describe('CA bundle path for verify-full'),
    debug: z.stringbool().default(false).describe('Log SQL (development only)'),
  }),
);

/**
 * SP7 C3 (spec §6.5): Job migrate chỉ nhận `DB_OWNER_PASSWORD` (allowlist của chart sinh từ `secretMeta`), nên chỉ
 * api và worker bị đòi mật khẩu `app_user`. Cùng mẫu với luật `identity-auth-db-password`.
 */
defineConfigRule('database-app-password-required', (c) =>
  c.app?.role !== 'migrate' && !c.database?.appPassword
    ? 'DB_APP_PASSWORD is required on api and worker'
    : undefined,
);

/** Spec SP1 §5.3: production bắt buộc `rejectUnauthorized: true`, chỉ `verify-full` đạt (xem `tls.ts`). */
defineProductionRule('database-tls', (c) =>
  c.database?.sslMode !== 'verify-full'
    ? 'DB_SSL_MODE must be verify-full in production'
    : undefined,
);
defineProductionRule('database-no-debug', (c) =>
  c.database?.debug ? 'DB_DEBUG must be false in production' : undefined,
);
/**
 * S2-R67: đường xấu nhất của một request api chạm DB core khi DB không trả lời (blackhole) phải xong trong ngân sách
 * HTTP: chờ connection + query quá hạn + ROLLBACK quá hạn (UnitOfWork: ROLLBACK xếp hàng sau query kẹt trên cùng
 * client và tự hết hạn). Lỗi quá hạn không được UnitOfWork chạy lại (chỉ 40001/40P01).
 */
defineProductionRule('database-query-deadline', (c) => {
  // SP7 C3: migrate không nạp namespace `http` (S7-D25) và không phục vụ request; ngân sách HTTP không áp cho nó.
  if (c.app?.role === 'migrate') return undefined;
  const connectMs = c.database?.connectionTimeoutMs;
  const queryMs = c.database?.queryTimeoutMs;
  const budgetMs = c.http?.requestBudgetMs;
  if (
    typeof connectMs !== 'number' ||
    typeof queryMs !== 'number' ||
    typeof budgetMs !== 'number'
  )
    return 'database query deadline rule needs the database and http config namespaces';
  const worstMs = connectMs + 2 * queryMs;
  return worstMs < budgetMs
    ? undefined
    : `DB_CONNECTION_TIMEOUT_MS + 2 x DB_QUERY_TIMEOUT_MS (${worstMs}) must be below HTTP_REQUEST_BUDGET_MS (${budgetMs} ms) in production`;
});
/**
 * S2-R70 (review item 7): deadline phía client của worker phải trên `statement_timeout` mà worker tự đặt
 * (`SET LOCAL`, UnitOfWork): câu chậm nhưng còn sống bị server huỷ trước (57014, giữ connection), deadline chỉ nổ khi
 * server không trả lời. `statement_timeout` của role app_relay nằm ngoài config app (compose `DB_RELAY_STATEMENT_TIMEOUT_MS`),
 * nên được kiểm lúc readiness (`DbStatementTimeoutCheck`).
 */
defineConfigRule('database-worker-query-deadline', (c) => {
  const deadlineMs = c.database?.workerQueryTimeoutMs;
  const statementMs = c.database?.workerStatementTimeoutMs;
  if (typeof deadlineMs !== 'number' || typeof statementMs !== 'number')
    return 'worker query deadline rule needs the database config namespace';
  return deadlineMs > statementMs
    ? undefined
    : `DB_WORKER_QUERY_TIMEOUT_MS (${deadlineMs}) must be above DB_WORKER_STATEMENT_TIMEOUT_MS (${statementMs})`;
});
/**
 * S2-R70: `connectionTimeoutMillis` của pg-pool vừa chặn kết nối mới vừa chặn chờ slot. Chờ slot ngắn hơn một câu hợp lệ
 * dài nhất thì job fail khi pool chỉ BẬN (một slot giữ câu 60 s), không phải khi DB chết.
 */
defineConfigRule('database-worker-connection-wait', (c) => {
  const waitMs = c.database?.workerConnectionTimeoutMs;
  const deadlineMs = c.database?.workerQueryTimeoutMs;
  if (typeof waitMs !== 'number' || typeof deadlineMs !== 'number')
    return 'worker connection wait rule needs the database config namespace';
  return waitMs >= deadlineMs
    ? undefined
    : `DB_WORKER_CONNECTION_TIMEOUT_MS (${waitMs}) must be at least DB_WORKER_QUERY_TIMEOUT_MS (${deadlineMs})`;
});
/**
 * S2-R72: bộ thu hồi checkout của worker/relay (`DB_WORKER_CHECKOUT_MAX_MS`) không được đi trước đường deadline: một câu
 * kẹt quá `DB_WORKER_QUERY_TIMEOUT_MS` rồi ROLLBACK xếp hàng sau nó cũng quá hạn (2 x deadline), sau đó mới tới lượt bộ
 * thu hồi. Job không khai timeout riêng (registry `defineJob` không có trường đó), nên không suy ra được "job dài nhất";
 * khoá này là mức tối đa được khai, luật chỉ giữ nó trên đường deadline. Áp mọi môi trường (đúng/sai, không phải chính sách).
 */
defineConfigRule('database-worker-checkout-max', (c) => {
  const maxMs = c.database?.workerCheckoutMaxMs;
  const deadlineMs = c.database?.workerQueryTimeoutMs;
  if (typeof maxMs !== 'number' || typeof deadlineMs !== 'number')
    return 'worker checkout max rule needs the database config namespace';
  return maxMs > 2 * deadlineMs
    ? undefined
    : `DB_WORKER_CHECKOUT_MAX_MS (${maxMs}) must be above 2 x DB_WORKER_QUERY_TIMEOUT_MS (${2 * deadlineMs})`;
});
