import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

/** Năm key của `email_deliveries_template_check` (SP2, `Migration20260927145436_email_deliveries`): ảnh chụp của migration. */
const SP2_TEMPLATE_KEYS = [
  'verify-email',
  'reset-password',
  'two-factor-changed',
  'existing-account',
  'change-email-confirmation',
] as const;

type Row = { public_id: string; template: string; state: string };

/**
 * Spec SP3 §6.13 bảng 3A: đổi `CHECK` template sang bảng tra cứu + FK không được mất hay đổi dòng `email_deliveries`
 * đang có, và `down` phải từ chối (không âm thầm xoá) khi còn dòng dùng template mà `CHECK` của SP2 không biết. Chạy
 * trên database riêng, migrate tới đúng migration này.
 */
describe('…_email_templates_lookup converts the template CHECK to an FK without touching data', () => {
  let db: ScratchDb;
  let upTo: MigrationObject[];
  let beforeLookup: MigrationObject[];
  let previous: string;
  let seeded: Row[];
  const source = (list: MigrationObject[]) => ({
    source: { kind: 'list' as const, list },
  });
  const withOwner = async <T>(fn: (c: pg.Client) => Promise<T>) => {
    const c = await db.client('owner');
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const deliveries = () =>
    withOwner(
      async (c) =>
        (
          await c.query<Row>(
            `SELECT public_id, template, state FROM email_deliveries ORDER BY public_id`,
          )
        ).rows,
    );
  const constraints = () =>
    withOwner(
      async (c) =>
        (
          await c.query<{ conname: string; convalidated: boolean }>(
            `SELECT conname, convalidated FROM pg_constraint
              WHERE conrelid = 'public.email_deliveries'::regclass
                AND conname IN ('email_deliveries_template_check', 'email_deliveries_template_fk')
              ORDER BY conname`,
          )
        ).rows,
    );
  const lookupExists = () =>
    withOwner(
      async (c) =>
        (
          await c.query<{ exists: boolean }>(
            `SELECT to_regclass('public.email_templates') IS NOT NULL AS exists`,
          )
        ).rows[0]?.exists,
    );

  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('tpllookup');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_email_templates_lookup'));
    if (at < 1) throw new Error('email_templates_lookup migration not found');
    upTo = all.slice(0, at + 1);
    beforeLookup = all.slice(0, at);
    previous = all[at - 1]!.name;
    await runMigrations('up', source(beforeLookup));
    // Một dòng mỗi template, đủ các trạng thái, ghi bằng app_user như ứng dụng (dưới CHECK của SP2).
    const app = await db.client('app');
    try {
      for (const template of SP2_TEMPLATE_KEYS) {
        const id = v7();
        await app.query(
          `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key)
           VALUES ($1, $2, 'en', 'x', 'y', 'PENDING', $3)`,
          [id, template, `${template}:${id}`],
        );
      }
      const sent = v7();
      await app.query(
        `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, attempts, completed_at, idempotency_key)
         VALUES ($1, 'reset-password', 'vi', 'x', NULL, 'SENT', 1, now(), $2)`,
        [sent, `reset-password:${sent}`],
      );
    } finally {
      await app.end();
    }
    seeded = await deliveries();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('up keeps every existing delivery and replaces the CHECK with a validated FK', async () => {
    expect(seeded).toHaveLength(SP2_TEMPLATE_KEYS.length + 1);
    await expect(runMigrations('up', source(upTo))).resolves.toEqual([
      upTo.at(-1)!.name,
    ]);
    expect(await deliveries()).toEqual(seeded);
    expect(await constraints()).toEqual([
      { conname: 'email_deliveries_template_fk', convalidated: true },
    ]);
  });
  it('down refuses while a delivery uses a template the SP2 CHECK does not know, and leaves the up state intact', async () => {
    const extra = v7();
    await withOwner(async (c) => {
      // Như migration của plan 3C/3D: chèn dòng tra cứu, rồi ứng dụng gửi thư bằng template mới.
      await c.query(`INSERT INTO email_templates (key) VALUES ('newsletter')`);
      await c.query(
        `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key)
         VALUES ($1, 'newsletter', 'en', 'x', 'y', 'PENDING', $2)`,
        [extra, `newsletter:${extra}`],
      );
    });
    await expect(
      runMigrations('down', { ...source(upTo), to: previous }),
    ).rejects.toThrow(/email_deliveries_template_check/);
    expect(await lookupExists()).toBe(true);
    expect(await constraints()).toEqual([
      { conname: 'email_deliveries_template_fk', convalidated: true },
    ]);
    expect(await deliveries()).toHaveLength(seeded.length + 1);

    await withOwner(async (c) => {
      await c.query(`DELETE FROM email_deliveries WHERE public_id = $1`, [
        extra,
      ]);
      await c.query(`DELETE FROM email_templates WHERE key = 'newsletter'`);
    });
  });
  it('once only SP2 templates remain, down restores the CHECK and keeps every delivery; up again is data-safe', async () => {
    await expect(
      runMigrations('down', { ...source(upTo), to: previous }),
    ).resolves.toEqual([upTo.at(-1)!.name]);
    expect(await lookupExists()).toBe(false);
    expect(await constraints()).toEqual([
      { conname: 'email_deliveries_template_check', convalidated: true },
    ]);
    expect(await deliveries()).toEqual(seeded);

    await runMigrations('up', source(upTo));
    expect(await deliveries()).toEqual(seeded);
    expect(await constraints()).toEqual([
      { conname: 'email_deliveries_template_fk', convalidated: true },
    ]);
  });
});
