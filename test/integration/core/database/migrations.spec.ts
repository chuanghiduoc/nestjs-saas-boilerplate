import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_MIGRATIONS_TABLE,
  runMigrations,
} from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import {
  coreMigrationList,
  fixtureMigrationList,
} from '../../../support/migrate-test-db.js';

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
  });
});
