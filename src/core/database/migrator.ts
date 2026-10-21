import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MigrationObject } from '@mikro-orm/core';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import pg from 'pg';
import type { ConfigOf } from '../config/index.js';
import { CORE_MIGRATIONS_TABLE, DIST_MIGRATIONS } from './constants.js';
import { databaseConfig } from './database.config.js';
import { tlsOptions } from './tls.js';

export type { MigrationObject };
export type MigrationSource =
  { kind: 'dist' } | { kind: 'list'; list: MigrationObject[] };
export type MigrationCommand = 'up' | 'down' | 'status';

/** Target của `down` nghĩa là revert toàn bộ. */
const DOWN_ALL = '0';
/** Đơn vị Postgres báo trong pg_settings cho hai timeout này. */
const TIMEOUT_UNIT = 'ms';
/**
 * Khoá advisory của migrator (spec SP7 S7-D24, R7-12). Dạng hai `int4`: không gian khoá tách khỏi khoá `bigint` một tham
 * số của tenancy (`tenancy_org_lock_key`) và partitions (6001, 6002), nên không org nào trùng khoá này. `1396785491` =
 * 0x53414153 ("SAAS").
 */
export const MIGRATION_ADVISORY_LOCK = {
  namespace: 1396785491,
  key: 1,
} as const;
/** `application_name` của phiên giữ khoá: runbook tìm phiên đó trong `pg_stat_activity`. */
export const MIGRATION_LOCK_APPLICATION_NAME = 'saas-migrator-lock';
/**
 * Pool MikroORM của migrator: `allOrNothing` chạy mọi migration trong MỘT transaction, nên một connection là đủ. Chart cộng
 * `1 (phiên khoá) + MIGRATION_ORM_POOL_MAX` vào budget Postgres trực tiếp (spec §12.5; test so hai số ở Task 13).
 */
export const MIGRATION_ORM_POOL_MAX = 1;
/**
 * `client_connection_check_interval` của mọi phiên migrator (review I2, R7-20): process chết (SIGKILL, mất TCP) thì backend
 * tự huỷ câu đang chạy trong khoảng này, thay vì chạy tiếp câu dài tới lần I/O sau trong khi khoá đã nhả.
 */
export const MIGRATION_CLIENT_CHECK_INTERVAL_MS = 10_000;
/**
 * Độ trễ của probe keepalive TCP ĐẦU TIÊN trên phiên khoá (mặc định OS 2 giờ). Chỉ đặt độ trễ ban đầu: khoảng cách và số
 * lần probe giữ mặc định của OS (Linux 75 s × 9 ≈ 11 phút), nên đây không phải đường phát hiện nhanh. Đường nhanh phía
 * server là `client_connection_check_interval`; phía client là sự kiện `error` của phiên khoá (round-2 m6).
 */
export const MIGRATION_LOCK_KEEPALIVE_DELAY_MS = 10_000;
/**
 * Hạn chờ một connection của pool ORM (pg-pool `connectionTimeoutMillis`, round-2 m3): pool có một slot, nên một yêu cầu
 * connection thứ hai (bug, hay MikroORM đổi cách dùng) ném "timeout exceeded when trying to connect" thay vì chờ mãi.
 */
export const MIGRATION_ORM_CONNECT_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_OPTION = `-c client_connection_check_interval=${MIGRATION_CLIENT_CHECK_INTERVAL_MS}`;
/** Phiên khoá rảnh suốt lượt: không role/DB default nào được cắt nó (`idle_session_timeout`). */
const LOCK_SESSION_OPTIONS = `${CHECK_INTERVAL_OPTION} -c idle_session_timeout=0`;
/** Mức pino của ERROR: dòng log của migrator cùng định dạng số mức với log app. */
const PINO_ERROR = 50;

export class MigrationLockBusyError extends Error {
  constructor() {
    super(
      'Another migration run holds the migration lock; wait for it or find the running migrate Job/command (docs/runbooks/migration-failure.md)',
    );
    this.name = 'MigrationLockBusyError';
  }
}
export class MigrationLockLostError extends Error {
  constructor(cause: unknown) {
    super(
      `The migration lock session was lost (${errorName(cause)}); the run was aborted and its connections closed — check pg_stat_activity before re-running`,
      { cause },
    );
    this.name = 'MigrationLockLostError';
  }
}

/** Migrator chạy ngoài Nest (không có logger DI): một dòng JSON trên stderr, cùng hình dạng log pino. Không bao giờ ghi giá trị env. */
function logMigratorError(
  event:
    | 'migration_lock_busy'
    | 'migration_lock_release_failed'
    | 'migration_lock_session_lost',
  fields: Record<string, string | number>,
): void {
  process.stderr.write(
    `${JSON.stringify({ level: PINO_ERROR, time: Date.now(), event, ...fields })}\n`,
  );
}
const errorName = (err: unknown): string =>
  err instanceof Error ? err.name : typeof err;

/** Kiểm `client_connection_check_interval` thật của phiên ORM (startup option có thể bị proxy làm rơi). Hàm thuần. */
export function assertClientCheckInterval(
  row: TimeoutSetting | undefined,
): void {
  if (
    !row ||
    row.unit !== TIMEOUT_UNIT ||
    Number(row.setting) !== MIGRATION_CLIENT_CHECK_INTERVAL_MS
  )
    throw new Error(
      `client_connection_check_interval is ${row ? `${row.setting}${row.unit ?? ''}` : 'missing'}, expected ${MIGRATION_CLIENT_CHECK_INTERVAL_MS}${TIMEOUT_UNIT}; DB_MIGRATION_HOST/PORT must point directly at Postgres`,
    );
}

type MigrationLock = {
  client: pg.Client;
  lost: Promise<never>;
  isLost: () => boolean;
  markReleased: () => void;
};

/**
 * Mở một phiên riêng (không thuộc pool của MikroORM) và giữ khoá phiên trên nó suốt lượt chạy: pool đóng connection rảnh
 * không làm mất khoá, và `unlock` chạy đúng trên phiên giữ khoá. Process chết thì phiên đóng, Postgres tự nhả khoá.
 * Phiên khoá chết giữa lượt (`error` của client) → `lost` reject `MigrationLockLostError`; `runMigrations` huỷ lượt.
 */
async function acquireMigrationLock(
  db: ConfigOf<typeof databaseConfig>,
): Promise<MigrationLock> {
  const client = new pg.Client({
    host: db.migrationHost,
    port: db.migrationPort,
    database: db.name,
    user: db.ownerUser,
    password: db.ownerPassword,
    ssl: tlsOptions(db),
    keepAlive: true,
    keepAliveInitialDelayMillis: MIGRATION_LOCK_KEEPALIVE_DELAY_MS,
    application_name: MIGRATION_LOCK_APPLICATION_NAME,
    options: LOCK_SESSION_OPTIONS,
  });
  // Round-2 m2: listener gắn TRƯỚC `connect`, nên không có khe nào mà `error` của client thành uncaught exception.
  // Lỗi trước khi giữ được khoá đã đi qua promise của connect/query; chỉ lỗi SAU khi giữ khoá mới là "mất phiên".
  let held = false;
  let released = false;
  let wasLost = false;
  let onLost: (err: MigrationLockLostError) => void = () => undefined;
  const lost = new Promise<never>((_, reject) => {
    onLost = reject;
  });
  // `lost` chỉ được đọc qua Promise.race; tránh unhandled rejection khi lượt đã xong trước đó.
  lost.catch(() => undefined);
  client.on('error', (err: Error) => {
    if (!held || released || wasLost) return;
    wasLost = true;
    logMigratorError('migration_lock_session_lost', { error: errorName(err) });
    onLost(new MigrationLockLostError(err));
  });
  try {
    await client.connect();
    const r = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [MIGRATION_ADVISORY_LOCK.namespace, MIGRATION_ADVISORY_LOCK.key],
    );
    if (r.rows[0]?.locked !== true) {
      logMigratorError('migration_lock_busy', {
        namespace: MIGRATION_ADVISORY_LOCK.namespace,
        key: MIGRATION_ADVISORY_LOCK.key,
      });
      throw new MigrationLockBusyError();
    }
    held = true;
  } catch (err) {
    await endLockClient(client);
    throw err;
  }
  return {
    client,
    lost,
    isLost: () => wasLost,
    markReleased: () => {
      released = true;
    },
  };
}

/** Đóng phiên khoá; lỗi đóng chỉ được log (phiên đóng hay socket chết đều nhả khoá phía Postgres). */
async function endLockClient(client: pg.Client): Promise<void> {
  try {
    await client.end();
  } catch (err) {
    logMigratorError('migration_lock_release_failed', {
      step: 'end',
      error: errorName(err),
    });
  }
}

/**
 * Nhả khoá trên đúng phiên giữ nó rồi đóng phiên, ở mọi nhánh. `markReleased` trước `unlock`: lỗi của phiên từ đây là
 * do chính việc đóng, không phải mất phiên. Phiên đã mất thì bỏ `unlock` (khoá đã nhả cùng phiên), chỉ `end()`.
 * Lỗi được log ERROR thay vì ném: hàm chạy trong `finally` và không được che lỗi của lượt; `end()` vẫn nhả khoá.
 */
async function releaseMigrationLock(lock: MigrationLock): Promise<void> {
  lock.markReleased();
  if (!lock.isLost())
    try {
      const r = await lock.client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1, $2) AS unlocked',
        [MIGRATION_ADVISORY_LOCK.namespace, MIGRATION_ADVISORY_LOCK.key],
      );
      if (r.rows[0]?.unlocked !== true)
        logMigratorError('migration_lock_release_failed', {
          step: 'unlock',
          error: 'not_held',
        });
    } catch (err) {
      logMigratorError('migration_lock_release_failed', {
        step: 'unlock',
        error: errorName(err),
      });
    }
  await endLockClient(lock.client);
}

export type TimeoutSetting = {
  name: string;
  setting: string;
  unit: string | null;
};
const TIMEOUT_NAMES = ['lock_timeout', 'statement_timeout'] as const;
export type ExpectedTimeouts = Record<(typeof TIMEOUT_NAMES)[number], number>;

/**
 * Ném lỗi nếu session migration không mang đúng lock_timeout/statement_timeout đã cấu hình
 * (vd. đi nhầm qua PgBouncer làm rơi startup parameter). Hàm thuần để test được độc lập.
 */
export function assertMigrationTimeouts(
  rows: readonly TimeoutSetting[],
  expected: ExpectedTimeouts,
): void {
  const problems = TIMEOUT_NAMES.flatMap((name) => {
    const row = rows.find((r) => r.name === name);
    if (!row) return [`${name} is missing`];
    if (row.unit !== TIMEOUT_UNIT || Number(row.setting) !== expected[name])
      return [
        `${name} is ${row.setting}${row.unit ?? ''}, expected ${expected[name]}${TIMEOUT_UNIT}`,
      ];
    return [];
  });
  if (problems.length)
    throw new Error(
      `Migration session timeouts are not applied (${problems.join('; ')}); DB_MIGRATION_HOST/PORT must point directly at Postgres, not PgBouncer`,
    );
}

/**
 * Chạy migration bằng role owner, **thẳng Postgres** qua DB_MIGRATION_HOST/PORT (Ruling R8,
 * không fallback về DB_HOST vì đó có thể là PgBouncer transaction mode).
 * lock_timeout/statement_timeout đi qua startup parameter của pg (áp cho mọi connection
 * của pool migrator) và được kiểm tra lại sau khi kết nối.
 * `status` trả về danh sách migration chưa chạy; `up`/`down` trả về migration đã chạy/đã revert.
 */
export async function runMigrations(
  cmd: MigrationCommand,
  opts: { to?: string; source?: MigrationSource; tableName?: string } = {},
): Promise<string[]> {
  const db = databaseConfig();
  const missing = [
    ...(db.migrationHost ? [] : ['DB_MIGRATION_HOST']),
    ...(db.migrationPort ? [] : ['DB_MIGRATION_PORT']),
    ...(db.ownerPassword ? [] : ['DB_OWNER_PASSWORD']),
  ];
  if (missing.length)
    throw new Error(
      `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required to run migrations (direct Postgres connection, owner role)`,
    );
  const lock = await acquireMigrationLock(db);
  try {
    const expected: ExpectedTimeouts = {
      lock_timeout: db.migrationLockTimeoutMs,
      statement_timeout: db.migrationStatementTimeoutMs,
    };
    const source = opts.source ?? { kind: 'dist' };
    /**
     * Client mà pool ORM đang cho mượn (C1). Mất phiên khoá thì trả chúng về pool kèm lỗi trước `orm.close`: pg-pool đóng
     * socket (câu đang chạy reject, transaction không COMMIT được) và gỡ client khỏi pool. Không chỉ `end()`: ROLLBACK của
     * Kysely 0.29.6 (`ControlledTransaction.rollback`) chỉ trả connection khi ROLLBACK thành công, nên trên socket đã đóng
     * client không bao giờ được trả và `pool.end()` của `orm.close` chờ mãi.
     */
    const borrowed = new Set<pg.PoolClient>();
    const orm = await MikroORM.init({
      extensions: [Migrator],
      entities: [],
      discovery: { warnWhenNoEntities: false },
      host: db.migrationHost,
      port: db.migrationPort,
      dbName: db.name,
      user: db.ownerUser,
      password: db.ownerPassword,
      pool: { min: 0, max: MIGRATION_ORM_POOL_MAX },
      driverOptions: {
        ssl: tlsOptions(db),
        ...expected,
        options: CHECK_INTERVAL_OPTION,
        connectionTimeoutMillis: MIGRATION_ORM_CONNECT_TIMEOUT_MS,
        onPoolCreated: (pool: pg.Pool) => {
          pool.on('acquire', (c) => borrowed.add(c));
          pool.on('release', (_err, c) => borrowed.delete(c));
        },
      },
      migrations: {
        tableName: opts.tableName ?? CORE_MIGRATIONS_TABLE,
        transactional: true,
        allOrNothing: true,
        snapshot: false,
        migrationsList:
          source.kind === 'list' ? source.list : await distMigrations(),
      },
    });
    try {
      const work = (async () => {
        const rows = await orm.em
          .fork()
          .execute<TimeoutSetting[]>(
            `SELECT name, setting, unit FROM pg_settings WHERE name IN ('lock_timeout', 'statement_timeout', 'client_connection_check_interval')`,
          );
        assertMigrationTimeouts(rows, expected);
        assertClientCheckInterval(
          rows.find((r) => r.name === 'client_connection_check_interval'),
        );
        switch (cmd) {
          case 'up':
            return (await orm.migrator.up()).map((m) => m.name);
          case 'status':
            return (await orm.migrator.getPending()).map((m) => m.name);
          case 'down':
            return await down(orm, opts.to);
          default: {
            const unknown: never = cmd;
            throw new Error(`Unknown migration command "${String(unknown)}"`);
          }
        }
      })();
      // Mất phiên khoá thắng cuộc đua: lỗi của `work` sau khi socket đóng chỉ là hệ quả (cause của MigrationLockLostError).
      work.catch(() => undefined);
      try {
        return await Promise.race([work, lock.lost]);
      } catch (err) {
        if (err instanceof MigrationLockLostError)
          // Bản sao: `release` phát sự kiện `release` và xoá client khỏi `borrowed` ngay trong vòng lặp.
          for (const c of [...borrowed]) c.release(err);
        throw err;
      }
    } finally {
      await orm.close(true);
    }
  } finally {
    await releaseMigrationLock(lock);
  }
}

const isMigrationClass = (v: unknown): v is MigrationObject['class'] =>
  typeof v === 'function' && v.prototype instanceof Migration;

/**
 * Nạp migration đã build trong `dist/migrations/**` (tương đối với file này, không theo cwd).
 * Không dùng discovery `path`/`glob` của MikroORM: trên Windows khi cwd khác ổ đĩa, glob
 * trả đường dẫn tương đối hỏng (`../../../D:/…`) và import thất bại.
 * Tên migration = tên file không đuôi = tên lớp (trùng với tên MikroORM ghi vào bảng theo dõi);
 * sắp theo tên (timestamp) để thứ tự không phụ thuộc thư mục module.
 */
async function distMigrations(): Promise<MigrationObject[]> {
  const dir = fileURLToPath(
    new URL(DIST_MIGRATIONS.relativeToMigrator, import.meta.url),
  );
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
    (f) => f.endsWith(DIST_MIGRATIONS.extension),
  );
  const list: MigrationObject[] = [];
  for (const file of files) {
    const name = basename(file, DIST_MIGRATIONS.extension);
    const mod: Record<string, unknown> = await import(
      pathToFileURL(join(dir, file)).href
    );
    const cls = mod[name];
    if (!isMigrationClass(cls))
      throw new Error(
        `Migration file ${file} must export a Migration class named ${name}`,
      );
    if (list.some((m) => m.name === name))
      throw new Error(`Duplicate migration name ${name} in ${dir}`);
    list.push({ name, class: cls });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

async function down(orm: MikroORM, to: string | undefined): Promise<string[]> {
  if (!to)
    throw new Error(
      'migrate down requires an explicit target: a migration name, or 0 to revert everything',
    );
  if (to === DOWN_ALL)
    return (await orm.migrator.down({ to: 0 })).map((m) => m.name);
  // MikroORM revert mọi migration nếu `to` không có trong danh sách đã chạy, nên chặn trước.
  const executed = (await orm.migrator.getExecuted()).map((m) => m.name);
  if (!executed.includes(to))
    throw new Error(
      `"${to}" is not an executed migration; refusing to migrate down`,
    );
  return (await orm.migrator.down({ to })).map((m) => m.name);
}
