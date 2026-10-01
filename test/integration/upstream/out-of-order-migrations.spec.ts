import { Migration } from '@mikro-orm/migrations';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

/** Migration của dự án (vùng `app/`) có timestamp mới hơn mọi migration boilerplate (spec SP7 S7-D31). */
class Migration20991231235959_app_fixture_newer extends Migration {
  override name = 'Migration20991231235959_app_fixture_newer';
  override up(): void | Promise<void> {
    this.addSql('SELECT 1');
  }
  override down(): void | Promise<void> {
    this.addSql('SELECT 1');
  }
}
const APP_NEWER: MigrationObject = {
  name: Migration20991231235959_app_fixture_newer.name,
  class: Migration20991231235959_app_fixture_newer,
};

describe('an upstream migration older than the project migrations still runs (UP-10, S7-D31, MikroORM getPending)', () => {
  applyTestEnv();
  const core = coreMigrationList();
  const lateUpstream = core.at(-1);
  let scratch: ScratchDb;
  beforeAll(async () => {
    if (!lateUpstream) throw new Error('no core migration found');
    scratch = await createScratchDb('upgrade_order');
    vi.stubEnv('DB_NAME', scratch.name);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await scratch?.drop();
  });

  it('runs the older upstream migration after the newer project migration, and nothing stays pending', async () => {
    const before = {
      kind: 'list' as const,
      list: [...core.slice(0, -1), APP_NEWER],
    };
    const after = { kind: 'list' as const, list: [...core, APP_NEWER] };
    await runMigrations('up', { source: before });
    expect(await runMigrations('status', { source: after })).toEqual([
      lateUpstream?.name,
    ]);
    expect(await runMigrations('up', { source: after })).toEqual([
      lateUpstream?.name,
    ]);
    expect(await runMigrations('status', { source: after })).toEqual([]);
  });
});
