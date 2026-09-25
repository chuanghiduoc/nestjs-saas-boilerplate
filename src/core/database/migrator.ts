import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MigrationObject } from '@mikro-orm/core';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
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
  const expected: ExpectedTimeouts = {
    lock_timeout: db.migrationLockTimeoutMs,
    statement_timeout: db.migrationStatementTimeoutMs,
  };
  const source = opts.source ?? { kind: 'dist' };
  const orm = await MikroORM.init({
    extensions: [Migrator],
    entities: [],
    discovery: { warnWhenNoEntities: false },
    host: db.migrationHost,
    port: db.migrationPort,
    dbName: db.name,
    user: db.ownerUser,
    password: db.ownerPassword,
    driverOptions: { ssl: tlsOptions(db), ...expected },
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
    assertMigrationTimeouts(
      await orm.em
        .fork()
        .execute<TimeoutSetting[]>(
          `SELECT name, setting, unit FROM pg_settings WHERE name IN ('lock_timeout', 'statement_timeout')`,
        ),
      expected,
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
  } finally {
    await orm.close(true);
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
