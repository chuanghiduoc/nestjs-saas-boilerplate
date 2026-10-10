import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  readOverrides,
  seedOrgEntitlement,
  seedOverride,
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
const REFUSAL = /org entitlement overrides hold staff decisions/;

/**
 * DB-4 (spec SP4 §7.7) cho migration 4C, trên database riêng (down để lại schema khác DB dùng chung). Danh sách migration
 * cắt tới `…_overrides`, để down chỉ lùi đúng các migration của SP4 dù sau này có migration mới hơn.
 */
describe('org_entitlement_overrides down refuses to drop staff decisions (spec SP4 §7.7, DB-4)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let beforeOverrides: string;
  let beforeCounters: string;
  let org: SeededOrg;
  const catalogState = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{
          overrides: string | null;
          counters: string | null;
          fn: string | null;
          storage: number;
          force: boolean | null;
        }>(
          `SELECT to_regclass('public.org_entitlement_overrides')::text AS overrides,
                  to_regclass('public.usage_counters')::text AS counters,
                  to_regprocedure('public.entitlements_override_value_ck()')::text AS fn,
                  (SELECT count(*)::int FROM entitlement_features WHERE key = 'files.storage_bytes') AS storage,
                  (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.org_entitlement_overrides')) AS force`,
        )
      ).rows[0];
    } finally {
      await c.end();
    }
  };
  const down = (to: string) =>
    runMigrations('down', { source: { kind: 'list', list }, to });
  const up = () => runMigrations('up', { source: { kind: 'list', list } });
  const clearOverrides = () =>
    withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, () =>
          c.query('DELETE FROM org_entitlement_overrides'),
        ),
      db.name,
    );
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('ovdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_overrides'));
    const counters = all.findIndex((m) => m.name.endsWith('_usage_counters'));
    if (at < 1 || counters < 1 || counters > at)
      throw new Error(
        'overrides or usage_counters migration not found in order',
      );
    list = all.slice(0, at + 1);
    beforeOverrides = all[at - 1]!.name;
    beforeCounters = all[counters - 1]!.name;
    await up();
    org = await seedOrg({ database: db.name });
    await seedOrgEntitlement(org.orgId, 'free', {}, db.name);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) down refuses while an override exists; the table, the function, FORCE and the override stay', async () => {
    await seedOverride(
      org.orgId,
      'tenancy.seats',
      { value: { limit: 4 } },
      db.name,
    );
    await expect(down(beforeOverrides)).rejects.toThrow(REFUSAL);
    expect(await catalogState()).toMatchObject({
      overrides: 'org_entitlement_overrides',
      fn: 'entitlements_override_value_ck()',
      force: true,
    });
    expect(
      (await readOverrides(org.orgId, db.name)).map((r) => r.limitValue),
    ).toEqual([4]);
  });
  it('(b) atomic: an override committed while the down waits on the table lock is seen, and the down refuses', async () => {
    await clearOverrides();
    const writer = await db.client('app');
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.org_id', $1, true)`, [
        org.orgId,
      ]);
      await writer.query(
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason)
         SELECT app_current_org(), id, 2, 'in flight' FROM entitlement_features WHERE key = 'tenancy.seats'`,
      );
      const pending = down(beforeOverrides);
      pending.catch(() => undefined);
      const watcher = await db.client('owner');
      try {
        const until = Date.now() + LOCK_DEADLINE_MS;
        for (;;) {
          const { rows } = await watcher.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.relation = to_regclass('public.org_entitlement_overrides')`,
          );
          if ((rows[0]?.n ?? 0) > 0) break;
          if (Date.now() > until)
            throw new Error(
              'the down never waited on the org_entitlement_overrides lock',
            );
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
    expect(
      (await readOverrides(org.orgId, db.name)).map((r) => r.limitValue),
    ).toEqual([2]);
  });
  it('(c) with no override left the down drops the table and the function; up restores them', async () => {
    await clearOverrides();
    await expect(down(beforeOverrides)).resolves.toEqual([list.at(-1)!.name]);
    expect(await catalogState()).toMatchObject({
      overrides: null,
      fn: null,
      force: null,
    });
    await up();
    expect(await catalogState()).toMatchObject({
      overrides: 'org_entitlement_overrides',
      fn: 'entitlements_override_value_ck()',
      force: true,
    });
  });
  it('(d) carried from 4B: an override on files.storage_bytes blocks reverting usage_counters; nothing changes; without it the chain reverts and up restores', async () => {
    await seedOverride(
      org.orgId,
      'files.storage_bytes',
      { value: { limit: 10 } },
      db.name,
    );
    await expect(down(beforeCounters)).rejects.toThrow(REFUSAL);
    expect(await catalogState()).toEqual({
      overrides: 'org_entitlement_overrides',
      counters: 'usage_counters',
      fn: 'entitlements_override_value_ck()',
      storage: 1,
      force: true,
    });
    expect(
      (await readOverrides(org.orgId, db.name)).map((r) => r.feature),
    ).toEqual(['files.storage_bytes']);
    await clearOverrides();
    await down(beforeCounters);
    expect(await catalogState()).toEqual({
      overrides: null,
      counters: null,
      fn: null,
      storage: 0,
      force: null,
    });
    await up();
    expect(await catalogState()).toMatchObject({
      overrides: 'org_entitlement_overrides',
      counters: 'usage_counters',
      storage: 1,
      force: true,
    });
  });
});
