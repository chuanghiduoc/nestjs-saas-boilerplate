import type { MigrationObject } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
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

/**
 * Chạy migration bằng role owner, **thẳng Postgres** (host relay, không qua PgBouncer
 * transaction mode). lock_timeout/statement_timeout đi qua startup parameter của pg
 * nên áp cho mọi connection của pool migrator.
 * `status` trả về danh sách migration chưa chạy; `up`/`down` trả về migration đã chạy/đã revert.
 */
export async function runMigrations(
  cmd: MigrationCommand,
  opts: { to?: string; source?: MigrationSource; tableName?: string } = {},
): Promise<string[]> {
  const db = databaseConfig();
  if (!db.ownerPassword)
    throw new Error('DB_OWNER_PASSWORD is required to run migrations');
  const source = opts.source ?? { kind: 'dist' };
  const orm = await MikroORM.init({
    extensions: [Migrator],
    entities: [],
    discovery: { warnWhenNoEntities: false },
    host: db.relayHost ?? db.host,
    port: db.relayPort ?? db.port,
    dbName: db.name,
    user: db.ownerUser,
    password: db.ownerPassword,
    driverOptions: {
      ssl: tlsOptions(db),
      lock_timeout: db.migrationLockTimeoutMs,
      statement_timeout: db.migrationStatementTimeoutMs,
    },
    migrations: {
      tableName: opts.tableName ?? CORE_MIGRATIONS_TABLE,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      ...(source.kind === 'list'
        ? { migrationsList: source.list }
        : { path: DIST_MIGRATIONS.path, glob: DIST_MIGRATIONS.glob }),
    },
  });
  try {
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
