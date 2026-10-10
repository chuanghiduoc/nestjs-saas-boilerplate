import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  readCounters,
  seedCounter,
  seedFeatures,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const POLL_MS = 20;
const LOCK_DEADLINE_MS = 8_000;
const REFUSAL = /usage counters hold consumed quota/;

/**
 * DB-4 (spec SP4 §7.7) cho migration 4B, trên database riêng (down để lại schema khác DB dùng chung). Danh sách migration
 * cắt tới `…_usage_counters` để down chỉ lùi đúng migration này dù sau này có migration mới hơn.
 */
describe('usage_counters down refuses to lose consumed quota (spec SP4 §7.7, DB-4)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let before: string;
  let org: SeededOrg;
  const catalogState = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{
          table: string | null;
          fn: string | null;
          feature: number;
          force: boolean | null;
        }>(
          `SELECT to_regclass('public.usage_counters')::text AS table,
                  to_regprocedure('public.entitlements_usage_counter_period_ck()')::text AS fn,
                  (SELECT count(*)::int FROM entitlement_features WHERE key = 'files.storage_bytes') AS feature,
                  (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.usage_counters')) AS force`,
        )
      ).rows[0];
    } finally {
      await c.end();
    }
  };
  const down = () =>
    runMigrations('down', { source: { kind: 'list', list }, to: before });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('ucdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_usage_counters'));
    if (at < 1) throw new Error('usage_counters migration not found');
    list = all.slice(0, at + 1);
    before = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    await seedFeatures(
      [
        {
          key: 'ucdown.calls',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          deprecated: false,
        },
      ],
      db.name,
    );
    org = await seedOrg({ database: db.name });
    await seedOrgEntitlement(org.orgId, 'free', {}, db.name);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) down refuses while a counter holds consumed quota; the table, the function, the feature row and FORCE stay', async () => {
    await seedCounter(
      org.orgId,
      'ucdown.calls',
      { used: 4, period: 'NONE' },
      db.name,
    );
    await expect(down()).rejects.toThrow(REFUSAL);
    expect(await catalogState()).toEqual({
      table: 'usage_counters',
      fn: 'entitlements_usage_counter_period_ck()',
      feature: 1,
      force: true,
    });
    expect((await readCounters(org.orgId, db.name)).map((r) => r.used)).toEqual(
      [4],
    );
  });
  it('(b) atomic: a consume committed while the down waits on the table lock is seen, and the down refuses', async () => {
    await withAppClient(
      (c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM usage_counters')),
      db.name,
    );
    const writer = await db.client('app');
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.org_id', $1, true)`, [
        org.orgId,
      ]);
      await writer.query(
        `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
         SELECT app_current_org(), id, NULL, 1, 1 FROM entitlement_features WHERE key = 'ucdown.calls'`,
      );
      const pending = down();
      pending.catch(() => undefined);
      const watcher = await db.client('owner');
      try {
        const until = Date.now() + LOCK_DEADLINE_MS;
        for (;;) {
          const { rows } = await watcher.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.relation = to_regclass('public.usage_counters')`,
          );
          if ((rows[0]?.n ?? 0) > 0) break;
          if (Date.now() > until)
            throw new Error('the down never waited on the usage_counters lock');
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } finally {
        await watcher.end();
      }
      await writer.query('COMMIT');
      await expect(pending).rejects.toThrow(REFUSAL);
    } finally {
      await writer.end();
    }
    expect((await readCounters(org.orgId, db.name)).map((r) => r.used)).toEqual(
      [1],
    );
  });
  it('(c) with no counter left the down drops the table, the function and the files.storage_bytes row; up restores them', async () => {
    await withAppClient(
      (c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM usage_counters')),
      db.name,
    );
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    expect(await catalogState()).toEqual({
      table: null,
      fn: null,
      feature: 0,
      force: null,
    });
    await runMigrations('up', { source: { kind: 'list', list } });
    expect(await catalogState()).toEqual({
      table: 'usage_counters',
      fn: 'entitlements_usage_counter_period_ck()',
      feature: 1,
      force: true,
    });
  });
});
