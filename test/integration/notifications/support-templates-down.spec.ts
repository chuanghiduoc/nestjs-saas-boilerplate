import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

/** Spec SP3 §6.13 bảng 3D: `down` xoá dòng tra cứu `support-access-notice`; còn thư dùng key → FK RESTRICT `23001`, không mất thư. */
describe('down of …_support_templates', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  const down = () =>
    runMigrations('down', { source: { kind: 'list', list }, to: previous });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('suptpl');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_support_templates'));
    if (at < 1) throw new Error('support_templates migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('a delivery that uses support-access-notice blocks the down with 23001; the row stays', async () => {
    const app = await db.client('app');
    const id = v7();
    try {
      await app.query(
        `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key) VALUES ($1, 'support-access-notice', 'en', 'x', 'y', 'PENDING', $2)`,
        [id, `support-access-notice:${id}`],
      );
    } finally {
      await app.end();
    }
    await expect(down()).rejects.toMatchObject({
      code: '23001',
      constraint: 'email_deliveries_template_fk',
    });
    const owner = await db.client('owner');
    try {
      expect(
        (
          await owner.query(
            `SELECT key FROM email_templates WHERE key = 'support-access-notice'`,
          )
        ).rows,
      ).toEqual([{ key: 'support-access-notice' }]);
      await owner.query(`DELETE FROM email_deliveries WHERE public_id = $1`, [
        id,
      ]);
    } finally {
      await owner.end();
    }
  });
  it('without deliveries the down removes exactly the support-access-notice key', async () => {
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      expect(
        (
          await owner.query(
            `SELECT count(*)::int AS n FROM email_templates WHERE key = 'support-access-notice'`,
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await owner.end();
    }
  });
});
