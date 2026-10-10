import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  FAKE_SECRET_ENC,
  insertEndpoint,
} from '../../support/integrations-seed.js';
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
const REFUSAL = /webhook endpoints or secrets exist/;

/** M4 (review 6C): down của `…_webhooks` không xoá cấu hình webhook và secret của khách; atomic với ghi đang mở. */
describe('webhooks down refuses while endpoints or secrets exist', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let before: string;
  let org: SeededOrg;
  const inOrgDb = <T>(fn: (c: pg.Client) => Promise<T>) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)), db.name);
  const tables = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{ endpoints: string | null; force: boolean | null }>(
          `SELECT to_regclass('public.webhook_endpoints')::text AS endpoints,
                  (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.webhook_endpoints')) AS force`,
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
    db = await createScratchDb('whdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_webhooks'));
    if (at < 1) throw new Error('webhooks migration not found');
    list = all.slice(0, at + 1);
    before = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) refuses while an endpoint exists; the table and FORCE stay', async () => {
    const e = await inOrgDb((c) => insertEndpoint(c, org.orgId));
    await expect(down()).rejects.toThrow(REFUSAL);
    expect(await tables()).toEqual({
      endpoints: 'webhook_endpoints',
      force: true,
    });
    await inOrgDb((c) =>
      c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [e.id]),
    );
  });
  it('(b) atomic: a secret committed while the down waits on the table lock is seen, and the down refuses', async () => {
    const e = await inOrgDb((c) => insertEndpoint(c, org.orgId));
    await inOrgDb((c) =>
      c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [e.id]),
    );
    const writer = await db.client('app');
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.org_id', $1, true)`, [
        org.orgId,
      ]);
      const { rows } = await writer.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (org_id, url) VALUES (app_current_org(), 'https://hooks.example.test/down') RETURNING id::text`,
      );
      await writer.query(
        `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES (app_current_org(), $1, $2)`,
        [rows[0]!.id, FAKE_SECRET_ENC],
      );
      const pending = down();
      pending.catch(() => undefined);
      const watcher = await db.client('owner');
      try {
        const until = Date.now() + LOCK_DEADLINE_MS;
        for (;;) {
          const { rows: w } = await watcher.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.relation = to_regclass('public.webhook_endpoints')`,
          );
          if ((w[0]?.n ?? 0) > 0) break;
          if (Date.now() > until)
            throw new Error(
              'the down never waited on the webhook_endpoints lock',
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
    await inOrgDb((c) => c.query(`DELETE FROM webhook_endpoints`));
  });
  it('(c) with no endpoint and no secret the down drops the schema; up restores it', async () => {
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    expect(await tables()).toEqual({ endpoints: null, force: null });
    await runMigrations('up', { source: { kind: 'list', list } });
    expect(await tables()).toEqual({
      endpoints: 'webhook_endpoints',
      force: true,
    });
  });
});
