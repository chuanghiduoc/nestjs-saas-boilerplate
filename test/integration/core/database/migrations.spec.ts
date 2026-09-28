import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_MIGRATIONS_TABLE,
  runMigrations,
  type MigrationObject,
} from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';
import {
  coreMigrationList,
  fixtureMigrationList,
} from '../../../support/migrate-test-db.js';

// Discover every app schema, including schemas introduced by future migrations.
const APP_SCHEMAS = `SELECT oid, nspname FROM pg_namespace
  WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'`;
const CATALOG_QUERIES = {
  tables: `SELECT n.nspname AS schema, c.relname AS table, c.relkind,
      c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN app_schemas n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')`,
  columns: `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
      a.attnum, format_type(a.atttypid, a.atttypmod) AS type,
      pg_get_expr(d.adbin, d.adrelid) AS default, a.attnotnull,
      a.attidentity, a.attgenerated
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN app_schemas n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
  constraints: `SELECT n.nspname AS schema, c.relname AS table, k.conname,
      pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN app_schemas n ON n.oid = k.connamespace
    LEFT JOIN pg_class c ON c.oid = k.conrelid`,
  indexes: `SELECT n.nspname AS schema, c.relname AS table,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    JOIN app_schemas n ON n.oid = c.relnamespace`,
  policies: `SELECT p.schemaname, p.tablename, p.policyname, p.permissive,
      ARRAY(SELECT role FROM unnest(p.roles) AS role ORDER BY role) AS roles,
      p.cmd, p.qual, p.with_check
    FROM pg_policies p JOIN app_schemas n ON n.nspname = p.schemaname`,
  tableGrants: `SELECT g.grantor, g.grantee, g.table_schema, g.table_name,
      g.privilege_type, g.is_grantable, g.with_hierarchy
    FROM information_schema.role_table_grants g
    JOIN app_schemas n ON n.nspname = g.table_schema`,
  // M2 (S2-R75 review): grant CỘT (vd. `GRANT UPDATE (notified_at) ON ...`) không nằm trong `tableGrants`
  // (bảng privilege ở mức TABLE) — round-trip trước đó không phát hiện một `down()` xoá nhầm grant cột.
  columnGrants: `SELECT g.grantor, g.grantee, g.table_schema, g.table_name,
      g.column_name, g.privilege_type, g.is_grantable
    FROM information_schema.role_column_grants g
    JOIN app_schemas n ON n.nspname = g.table_schema`,
  // M2 (S2-R75 review): trigger đầu tiên của codebase (`user_two_factor_notice_trg`) không nằm trong bất kỳ query
  // nào ở trên — một `down()` xoá nhầm trigger nhưng giữ nguyên hàm (hoặc trigger lệch `WHEN`/`OF`) từng lọt qua
  // round-trip và sweep từng-bước (S2-R57). `NOT t.tgisinternal` bỏ trigger nội bộ của FK (tự quản theo constraint).
  triggers: `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS trigger,
      pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN app_schemas n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal`,
  functions: `SELECT n.nspname AS schema, p.proname,
      pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_functiondef(p.oid) AS definition, pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p JOIN app_schemas n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p', 'w')`,
  functionPrivileges: `SELECT n.nspname AS schema, p.proname,
      pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_userbyid(a.grantor) AS grantor,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
      a.privilege_type, a.is_grantable
    FROM pg_proc p JOIN app_schemas n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.prokind IN ('f', 'p', 'w')`,
};

async function catalogSnapshot(): Promise<Record<string, string[]>> {
  const { pg: database } = getInfra();
  const owner = new pg.Client({
    host: database.host,
    port: database.port,
    database: database.database,
    ...database.owner,
  });
  try {
    await owner.connect();
    await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot: Record<string, string[]> = {};
    for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
      const { rows } = await owner.query<{ entry: string }>(
        `WITH app_schemas AS (${APP_SCHEMAS})
         SELECT to_jsonb(entry)::text AS entry FROM (${query}) entry
         ORDER BY to_jsonb(entry)::text COLLATE "C"`,
      );
      snapshot[name] = rows.map((row) => row.entry);
    }
    await owner.query('COMMIT');
    return snapshot;
  } finally {
    // Closing the connection also rolls back an interrupted snapshot transaction.
    await owner.end();
  }
}

/**
 * S2-R57 (I1): sweep "down to 0 → up" trên toàn bộ danh sách không phát hiện được một `down()` sai
 * nếu migration đó chỉ ALTER một bảng do migration trước đó tạo — DROP TABLE của migration trước
 * (chạy sau, vì unwind theo thứ tự ngược) xoá sạch hậu quả của cái no-op, sweep vẫn khớp catalog.
 * Kiểm từng migration độc lập: up đúng một migration (giới hạn `source.list` tới đúng migration đó
 * để `up()` không chạy luôn các migration sau), down đúng một bước (API `to` có sẵn của
 * `runMigrations`, trỏ vào migration ngay trước — hoặc '0' nếu là migration đầu), rồi so catalog.
 */
async function assertEachMigrationRevertsCleanly(
  fullList: MigrationObject[],
  tableName?: string,
): Promise<void> {
  for (let i = 0; i < fullList.length; i++) {
    const opts = {
      source: { kind: 'list' as const, list: fullList.slice(0, i + 1) },
      tableName,
    };
    const previous = i === 0 ? undefined : fullList[i - 1];
    if (i > 0 && !previous)
      throw new Error(`No migration before index ${i} in the given list`);
    const before = await catalogSnapshot();
    await runMigrations('up', opts);
    await runMigrations('down', {
      ...opts,
      to: previous ? previous.name : '0',
    });
    expect(await catalogSnapshot()).toEqual(before);
    // Áp lại trước khi qua migration kế tiếp, để snapshot "before" của vòng sau đúng là trạng thái
    // đã có migration này.
    await runMigrations('up', opts);
  }
}

describe('migrations', () => {
  applyTestEnv();
  const source = { kind: 'list' as const, list: coreMigrationList() };
  const fixtures = {
    source: { kind: 'list' as const, list: fixtureMigrationList() },
    tableName: FIXTURE_MIGRATIONS_TABLE,
  };
  afterAll(async () => {
    await runMigrations('up', { source });
    await runMigrations('up', fixtures);
  });

  it('refuses down without an explicit target', async () => {
    await expect(runMigrations('down', { source })).rejects.toThrow(
      /explicit target/,
    );
  });
  it('refuses down to an unknown migration name', async () => {
    await expect(
      runMigrations('down', { source, to: 'Migration_typo' }),
    ).rejects.toThrow(/not an executed migration/);
  });
  it('connects directly to Postgres with the configured session timeouts (check passes)', async () => {
    // runMigrations kiểm tra pg_settings sau khi kết nối và ném nếu timeout không khớp.
    await expect(runMigrations('status', { source })).resolves.toEqual([]);
  });
  it('refuses to run without DB_MIGRATION_HOST (no fallback to DB_HOST/PgBouncer)', async () => {
    const original = process.env.DB_MIGRATION_HOST;
    vi.stubEnv('DB_MIGRATION_HOST', undefined);
    try {
      await expect(runMigrations('status', { source })).rejects.toThrow(
        /DB_MIGRATION_HOST is required to run migrations/,
      );
    } finally {
      vi.stubEnv('DB_MIGRATION_HOST', original);
    }
  });
  it('up → down to 0 → up is repeatable', async () => {
    // Catalog only: keep bookkeeping table structure, never its changing rows.
    const before = await catalogSnapshot();
    // Policy RLS của bảng fixture phụ thuộc app_current_org() của core, nên revert fixture trước.
    await runMigrations('down', { ...fixtures, to: '0' });
    await runMigrations('down', { source, to: '0' });
    expect((await runMigrations('status', { source })).length).toBeGreaterThan(
      0,
    );
    await runMigrations('up', { source });
    await runMigrations('up', fixtures);
    expect(await runMigrations('status', { source })).toEqual([]);
    expect(await runMigrations('status', fixtures)).toEqual([]);
    expect(await catalogSnapshot()).toEqual(before);
  });
  it('each migration reverts cleanly on its own (not masked by a later DROP TABLE)', async () => {
    // Cùng điểm xuất phát với test round-trip toàn bộ: revert hết, fixture trước (RLS của fixture
    // phụ thuộc app_current_org() của core).
    await runMigrations('down', { ...fixtures, to: '0' });
    await runMigrations('down', { source, to: '0' });

    await assertEachMigrationRevertsCleanly(coreMigrationList());
    await assertEachMigrationRevertsCleanly(
      fixtureMigrationList(),
      FIXTURE_MIGRATIONS_TABLE,
    );
  });
});
