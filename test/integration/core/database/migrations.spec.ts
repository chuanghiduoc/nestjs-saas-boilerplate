import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import { coreMigrationList } from '../../../support/migrate-test-db.js';

describe('migrations', () => {
  applyTestEnv();
  const source = { kind: 'list' as const, list: coreMigrationList() };
  afterAll(async () => {
    await runMigrations('up', { source });
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
  it('up → down to 0 → up is repeatable', async () => {
    await runMigrations('down', { source, to: '0' });
    expect((await runMigrations('status', { source })).length).toBeGreaterThan(
      0,
    );
    await runMigrations('up', { source });
    expect(await runMigrations('status', { source })).toEqual([]);
  });
});
