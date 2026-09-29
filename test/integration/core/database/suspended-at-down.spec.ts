import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import { coreMigrationList } from '../../../support/migrate-test-db.js';
import {
  createScratchDb,
  type ScratchDb,
} from '../../../support/scratch-db.js';

/**
 * Spec SP3 §6.13 bảng 3A + "Test migration": `down` của `suspended_at` phải từ chối khi còn lịch của org xoá mềm,
 * vì bỏ cột sẽ làm lịch đó chạy lại. Chạy trên database riêng, migrate tới đúng migration này, nên không phụ thuộc các
 * migration sau (FK tới `organizations` ở Task 16).
 */
describe('down of …_scheduled_tasks_suspended_at refuses while a suspended schedule exists', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('suspdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) =>
      m.name.endsWith('_scheduled_tasks_suspended_at'),
    );
    if (at < 1) throw new Error('suspended_at migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('a suspended row seeded by app_user inside its org blocks the down; the owner under FORCE would see nothing (why NO FORCE)', async () => {
    const org = v7();
    const app = await db.client('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      await app.query(
        `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled, suspended_at)
         VALUES ($1, 'report', 'fixture.tenant.report', '0 8 * * 1', 'UTC', '{}', true, now())`,
        [org],
      );
      await app.query('COMMIT');
    } finally {
      await app.end();
    }
    const owner = await db.client('owner');
    try {
      // r1 đọc dưới FORCE bằng app_owner (không policy): 0 dòng, guard không bao giờ chặn (DB2-N2).
      expect(
        (
          await owner.query(
            `SELECT count(*)::int AS n FROM scheduled_tasks WHERE suspended_at IS NOT NULL`,
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await owner.end();
    }
    await expect(
      runMigrations('down', { source: { kind: 'list', list }, to: previous }),
    ).rejects.toThrow(
      /scheduled tasks of soft-deleted organizations would run again/,
    );
    const again = await db.client('owner');
    try {
      const { rows } = await again.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'scheduled_tasks' AND column_name = 'suspended_at'`,
      );
      expect(rows).toEqual([{ n: 1 }]);
      const force = await again.query(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'scheduled_tasks'`,
      );
      expect(force.rows).toEqual([{ relforcerowsecurity: true }]);
    } finally {
      await again.end();
    }
  });
  it('once the suspended row is gone the down succeeds', async () => {
    const owner = await db.client('owner');
    try {
      await owner.query(
        `ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY`,
      );
      await owner.query(`DELETE FROM scheduled_tasks`);
      await owner.query(`ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY`);
    } finally {
      await owner.end();
    }
    await expect(
      runMigrations('down', { source: { kind: 'list', list }, to: previous }),
    ).resolves.toEqual([list.at(-1)!.name]);
  });
});
