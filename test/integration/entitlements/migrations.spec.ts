import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import {
  toEnvelope,
  type OutboxRow,
} from '../../../src/core/events/event-dispatch.handlers.js';
import { PlanChangedEvent } from '../../../src/modules/entitlements/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { readOrgEntitlement } from '../../support/entitlements-seed.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedOrg, withAppClient } from '../../support/tenancy-seed.js';

const OUTBOX_SQL = `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
  aggregate_version::text AS aggregate_version, payload, headers, occurred_at
  FROM outbox_events WHERE type = 'entitlements.plan.changed' AND org_id = ANY($1::uuid[]) ORDER BY org_id`;

/**
 * Spec SP4 §7.7 dòng `example/…_starter_plans`, DB-4: backfill org có sẵn trước SP4 (mẫu 7 bước), event parse được, FORCE
 * bật lại, down không làm mất gán của billing/nhân viên. Database riêng: org được seed TRƯỚC migration mẫu.
 */
describe('starter plans migration (template zone, spec SP4 §7.7, DB-4)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let beforeStarter: string;
  const orgIds: string[] = [];
  const force = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{ relname: string; f: boolean }>(
          `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('organizations', 'org_entitlements') ORDER BY relname`,
        )
      ).rows;
    } finally {
      await c.end();
    }
  };
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('starter');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_starter_plans'));
    if (at < 1) throw new Error('starter_plans migration not found');
    list = all.slice(0, at + 1);
    beforeStarter = all[at - 1]!.name;
    await runMigrations('up', {
      source: { kind: 'list', list: all.slice(0, at) },
    });
    for (let i = 0; i < 2; i++)
      orgIds.push((await seedOrg({ database: db.name })).orgId);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('backfills every existing org with free/DEFAULT and exactly one plan.changed event each, parsed by PlanChangedEvent; FORCE is back', async () => {
    await runMigrations('up', { source: { kind: 'list', list } });
    for (const id of orgIds)
      expect(await readOrgEntitlement(id, db.name)).toEqual({
        planKey: 'free',
        source: 'DEFAULT',
        sourceRef: null,
        reason: null,
        lastBillingSeq: null,
        version: 1,
      });
    const c = await db.client('owner');
    try {
      const { rows } = await c.query<OutboxRow>(OUTBOX_SQL, [orgIds]);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const e = parseEnvelope(PlanChangedEvent, toEnvelope(row));
        expect(e.data).toEqual({
          orgId: row.org_id,
          fromPlan: null,
          toPlan: 'free',
          cause: 'DEFAULT',
          causeRef: null,
        });
        expect([e.actor, e.aggregate]).toEqual([
          { type: 'system', id: 'migration:starter_plans' },
          { type: 'org_entitlement', id: row.org_id, version: 1 },
        ]);
      }
      expect(
        (await c.query(`SELECT key FROM plans ORDER BY key`)).rows,
      ).toEqual([{ key: 'free' }, { key: 'pro' }]);
    } finally {
      await c.end();
    }
    expect(await force()).toEqual([
      { relname: 'org_entitlements', f: true },
      { relname: 'organizations', f: true },
    ]);
  });
  it('down refuses while an org has a plan assigned by billing, leaving the database unchanged', async () => {
    const [first] = orgIds;
    if (!first) throw new Error('no seeded org');
    await withAppClient(
      (c) =>
        inOrgTx(c, first, () =>
          c.query(
            `UPDATE org_entitlements SET plan_source = 'BILLING', plan_source_ref = 'sub_1', last_billing_seq = 1`,
          ),
        ),
      db.name,
    );
    await expect(
      runMigrations('down', {
        source: { kind: 'list', list },
        to: beforeStarter,
      }),
    ).rejects.toThrow(/assigned by billing or platform staff/);
    expect((await readOrgEntitlement(first, db.name))?.source).toBe('BILLING');
    expect(await force()).toEqual([
      { relname: 'org_entitlements', f: true },
      { relname: 'organizations', f: true },
    ]);
  });
  it('once every row is DEFAULT again the down removes the rows and the two plans', async () => {
    const [first] = orgIds;
    if (!first) throw new Error('no seeded org');
    await withAppClient(
      (c) =>
        inOrgTx(c, first, () =>
          c.query(
            `UPDATE org_entitlements SET plan_source = 'DEFAULT', plan_source_ref = NULL`,
          ),
        ),
      db.name,
    );
    await expect(
      runMigrations('down', {
        source: { kind: 'list', list },
        to: beforeStarter,
      }),
    ).resolves.toEqual([list.at(-1)!.name]);
    for (const id of orgIds)
      expect(await readOrgEntitlement(id, db.name)).toBeUndefined();
    const c = await db.client('owner');
    try {
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM plans`)).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await c.end();
    }
  });
});
