import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import {
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
} from '../../support/integrations-seed.js';
import {
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const TABLES = ['webhook_messages', 'webhook_deliveries'] as const;
const month = (offset: number) => {
  const now = new Date();
  const lo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
  const hi = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1),
  );
  return {
    tag: `${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`,
    lo: lo.toISOString(),
    hi: hi.toISOString(),
  };
};

describe('webhook_partitions_maintain (spec SP6 §6.7, W-44, R6-17)', () => {
  let owner: pg.Client;
  let org: SeededOrg;
  const asPartitionOwner = async (statements: string[]) => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE partition_owner');
      for (const s of statements) await owner.query(s);
      await owner.query('RESET ROLE');
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK');
      throw err;
    }
  };
  const partitions = async (table: string) =>
    (
      await owner.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass ORDER BY 1`,
        [`public.${table}`],
      )
    ).rows.map((r) => r.name);
  /** Gỡ partition tháng quá khứ nếu còn (deliveries trước messages, P2). */
  const detachPast = async (offset: number) => {
    for (const t of ['webhook_deliveries', 'webhook_messages']) {
      const name = `${t}_p${month(offset).tag}`;
      const { rows } = await owner.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`public.${name}`],
      );
      if (rows[0]?.present)
        await asPartitionOwner([
          `ALTER TABLE public.${t} DETACH PARTITION public.${name}`,
          `DROP TABLE public.${name}`,
        ]);
    }
  };
  const attachPast = async (offset: number) => {
    await detachPast(offset);
    const m = month(offset);
    await asPartitionOwner(
      TABLES.flatMap((t) => [
        `CREATE TABLE public.${t}_p${m.tag} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
        `ALTER TABLE public.${t} ATTACH PARTITION public.${t}_p${m.tag} FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
      ]),
    );
  };
  const maintain = (
    c: pg.Client,
    retention: number | null,
    premake: number | null,
  ) =>
    c.query<{ action: string; partition_name: string }>(
      'SELECT action, partition_name FROM webhook_partitions_maintain($1, $2)',
      [retention, premake],
    );

  beforeAll(async () => {
    applyTestEnv();
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
    org = await seedOrg();
  });
  afterAll(async () => {
    for (const o of [-6, -5, -4, -3]) await detachPast(o);
    await org?.dispose();
    await owner?.end();
  });

  it('the migration made the current month and three months ahead for both tables; a rerun is a no-op', async () => {
    for (const t of TABLES)
      for (const i of [0, 1, 2, 3])
        expect(await partitions(t)).toContain(`${t}_p${month(i).tag}`);
    expect((await withAppClient((c) => maintain(c, 1, 3))).rows).toEqual([]);
  });
  it('drops expired months deliveries first, keeps the month at the boundary, and the rows go with them (W-44)', async () => {
    await attachPast(-4);
    await attachPast(-3);
    await inOrg(org.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, org.orgId);
      const message = await insertMessage(c, org.orgId, {
        createdAt: month(-4).lo,
      });
      await insertDelivery(c, org.orgId, { endpoint, message });
    });
    // retention 3: cutoff = đầu tháng -3; tháng -4 hết hạn trọn, tháng -3 (biên) còn.
    const res = await withAppClient((c) => maintain(c, 3, 3));
    expect(res.rows).toEqual([
      {
        action: 'dropped',
        partition_name: `webhook_deliveries_p${month(-4).tag}`,
      },
      {
        action: 'dropped',
        partition_name: `webhook_messages_p${month(-4).tag}`,
      },
    ]);
    for (const t of TABLES)
      expect(await partitions(t)).toContain(`${t}_p${month(-3).tag}`);
  });
  it.each([
    [0, 3, /p_retention_months must be between 1 and 120/],
    [121, 3, /p_retention_months must be between 1 and 120/],
    [1, 0, /p_premake_months must be between 1 and 12/],
    [null, 3, /must not be NULL/],
  ])(
    'refuses retention %s / premake %s even when called directly',
    async (r, p, re) => {
      await expect(withAppClient((c) => maintain(c, r, p))).rejects.toThrow(re);
    },
  );
  it('a second concurrent run is a no-op while the first holds advisory lock 6002 (R6-17)', async () => {
    await attachPast(-5);
    await withAppClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT pg_advisory_xact_lock(6002)');
        expect((await withAppClient((c) => maintain(c, 3, 3))).rows).toEqual(
          [],
        );
      } finally {
        await holder.query('ROLLBACK');
      }
    });
    expect(
      (await withAppClient((c) => maintain(c, 3, 3))).rows.map(
        (r) => r.partition_name,
      ),
    ).toEqual([
      `webhook_deliveries_p${month(-5).tag}`,
      `webhook_messages_p${month(-5).tag}`,
    ]);
  });
  it('an unexpected partition name makes the run fail loud', async () => {
    const m = month(-6);
    await asPartitionOwner([
      `CREATE TABLE public.webhook_messages_odd (LIKE public.webhook_messages INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      `ALTER TABLE public.webhook_messages ATTACH PARTITION public.webhook_messages_odd FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
    ]);
    try {
      await expect(withAppClient((c) => maintain(c, 3, 3))).rejects.toThrow(
        /unexpected partition webhook_messages_odd/,
      );
    } finally {
      await asPartitionOwner([
        `ALTER TABLE public.webhook_messages DETACH PARTITION public.webhook_messages_odd`,
        `DROP TABLE public.webhook_messages_odd`,
      ]);
    }
  });
  it('one run over both tables with drops finishes inside the app_user statement_timeout (ADR 0020 P1 budget)', async () => {
    await attachPast(-4);
    const t0 = performance.now();
    await withAppClient((c) => maintain(c, 3, 3));
    const ms = performance.now() - t0;
    process.stdout.write(
      `${JSON.stringify({ event: 'webhook_partitions_maintain_ms', ms: Math.round(ms) })}\n`,
    );
    expect(ms).toBeLessThan(5000);
  });
});
