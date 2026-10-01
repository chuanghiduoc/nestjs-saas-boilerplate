import { Logger, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import {
  MaintainPartitionsHandler,
  PartitionsModule,
  definePartitionedTable,
} from '../../../../src/core/partitions/index.js';
import type { JobContext } from '../../../../src/core/queue/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';
import { installOtelCapture } from '../../../support/otel-capture.js';
import { inOrgTx, withAppClient } from '../../../support/tenancy-seed.js';

const otel = installOtelCapture();
const TABLE = 'fixture_part_events';
/** Như fixture migration: sàn retention 1, premake 3 (tháng hiện tại + 3). */
const PREMAKE = 3;
/** Retention dùng ở ca drop: tháng −3 hết hạn, tháng −2 (biên) và −1 ở lại. */
const RETENTION = 2;
const PROBE_LOCK_TIMEOUT = '1s';
/** Giá trị `lock_timeout` riêng của transaction gọi hàm, khác 5 s của hàm và khác mặc định, để thấy rò rỉ nếu có. */
const CALLER_LOCK_TIMEOUT = '17s';
definePartitionedTable({
  tables: [TABLE],
  maintainFunction: 'fixture_part_events_maintain',
  lockKey: 6900n,
  retentionMonths: () => RETENTION,
  premakeMonths: () => PREMAKE,
});
/** Mục hỏng: hàm không tồn tại (42883) — handler phải chạy tiếp mục khác rồi mới ném. */
definePartitionedTable({
  tables: ['fixture_missing'],
  maintainFunction: 'fixture_missing_maintain',
  lockKey: 6901n,
  retentionMonths: () => 1,
  premakeMonths: () => 1,
});

/** Tháng UTC lệch `offset`: tên partition, cận dưới và cận trên ISO. */
const month = (offset: number) => {
  const now = new Date();
  const lo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
  const hi = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1),
  );
  const name = `${TABLE}_p${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`;
  return { name, lo: lo.toISOString(), hi: hi.toISOString() };
};

describe('partition maintenance on the fixture table (spec SP6 §6.7, C-5, R6-17)', () => {
  let owner: pg.Client;
  let app: INestApplication;
  beforeAll(async () => {
    // Handler chạy trên worker: `UnitOfWork` của worker đặt `statement_timeout = DB_WORKER_STATEMENT_TIMEOUT_MS` trong
    // transaction (ngân sách thật của cron, ADR 0020 P1).
    vi.stubEnv('APP_ROLE', 'worker');
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      PartitionsModule,
    ]);
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
    vi.unstubAllEnvs();
  });
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
  const detach = async (name: string) => {
    const { rows } = await owner.query(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${name}`],
    );
    if (rows[0]?.present)
      await asPartitionOwner([
        `ALTER TABLE public.${TABLE} DETACH PARTITION public.${name}`,
        `DROP TABLE public.${name}`,
      ]);
  };
  /** Gắn tháng `offset` (gỡ bản còn sót của lần chạy trước để test lặp lại được). */
  const attach = async (offset: number) => {
    const m = month(offset);
    await detach(m.name);
    await asPartitionOwner([
      `CREATE TABLE public.${m.name} (LIKE public.${TABLE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      `ALTER TABLE public.${TABLE} ATTACH PARTITION public.${m.name} FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
    ]);
  };
  const partitions = async () =>
    (
      await owner.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'public.${TABLE}'::regclass ORDER BY 1`,
      )
    ).rows.map((r) => r.name);
  const maintain = (
    c: pg.Client,
    retention: number | null,
    premake: number | null,
  ) =>
    c.query<{ action: string; partition_name: string }>(
      `SELECT action, partition_name FROM fixture_part_events_maintain($1, $2)`,
      [retention, premake],
    );
  const expectedNow = () => [0, 1, 2, 3].map((i) => month(i).name);

  it('creates the current month and premake months ahead, idempotently', async () => {
    await detach(month(PREMAKE).name);
    const first = await withAppClient((c) => maintain(c, RETENTION, PREMAKE));
    expect(first.rows).toEqual([
      { action: 'created', partition_name: month(PREMAKE).name },
    ]);
    expect(
      (await withAppClient((c) => maintain(c, RETENTION, PREMAKE))).rows,
    ).toEqual([]);
    expect(await partitions()).toEqual(expectedNow());
  });
  it('drops only partitions whose whole month is older than the retention; the boundary month stays', async () => {
    for (const i of [-3, -2, -1]) await attach(i);
    const res = await withAppClient((c) => maintain(c, RETENTION, PREMAKE));
    expect(res.rows).toEqual([
      { action: 'dropped', partition_name: month(-3).name },
    ]);
    expect(await partitions()).toEqual(
      [month(-2).name, month(-1).name, ...expectedNow()].sort(),
    );
    for (const i of [-2, -1]) await detach(month(i).name);
  });
  it.each([
    [0, PREMAKE, /p_retention_months must be between 1 and 120/],
    [121, PREMAKE, /p_retention_months must be between 1 and 120/],
    [RETENTION, 0, /p_premake_months must be between 1 and 12/],
    [RETENTION, 13, /p_premake_months must be between 1 and 12/],
    [null, PREMAKE, /must not be NULL/],
  ] as const)(
    'refuses retention %s, premake %s (floor enforced inside the function)',
    async (r, p, re) => {
      await withAppClient(async (c) => {
        await expect(maintain(c, r, p)).rejects.toThrow(re);
      });
    },
  );
  it('lock_timeout is a property of the function: the caller transaction keeps its own value after the call (pattern 6B/6C copy)', async () => {
    const shown = (c: pg.Client) =>
      c
        .query<{ lock_timeout: string }>('SHOW lock_timeout')
        .then((r) => r.rows[0]?.lock_timeout);
    await detach(month(PREMAKE).name);
    await withAppClient(async (c) => {
      // Như lô migration `allOrNothing` gọi hàm để tạo partition đầu rồi chạy tiếp migration khác: cùng MỘT transaction.
      await c.query('BEGIN');
      try {
        const sessionDefault = await shown(c);
        expect((await maintain(c, RETENTION, PREMAKE)).rows).toEqual([
          { action: 'created', partition_name: month(PREMAKE).name },
        ]);
        expect(await shown(c)).toBe(sessionDefault);
        await c.query(`SET LOCAL lock_timeout = '${CALLER_LOCK_TIMEOUT}'`);
        await maintain(c, RETENTION, PREMAKE);
        expect(await shown(c)).toBe(CALLER_LOCK_TIMEOUT);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    const { rows } = await owner.query<{ config: string[] }>(
      `SELECT proconfig AS config FROM pg_proc WHERE oid = 'public.fixture_part_events_maintain(integer, integer)'::regprocedure`,
    );
    expect(rows[0]?.config).toEqual(['search_path=""', 'lock_timeout=5s']);
  });
  it('two concurrent runs: the second is a no-op while the first holds the advisory lock (R6-17)', async () => {
    await attach(-3);
    const a = await withAppClient(async (first) => {
      await first.query('BEGIN');
      try {
        expect((await maintain(first, RETENTION, PREMAKE)).rows).toEqual([
          { action: 'dropped', partition_name: month(-3).name },
        ]);
        const second = await withAppClient((c) =>
          maintain(c, RETENTION, PREMAKE),
        );
        return second.rows;
      } finally {
        await first.query('ROLLBACK');
      }
    });
    expect(a).toEqual([]);
    expect(await partitions()).toContain(month(-3).name);
    expect(
      (await withAppClient((c) => maintain(c, RETENTION, PREMAKE))).rows,
    ).toEqual([{ action: 'dropped', partition_name: month(-3).name }]);
  });
  it('a partition is closed to app_user; the append-only trigger of the parent fires on the partition', async () => {
    const org = v7();
    await withAppClient((c) =>
      inOrgTx(c, org, () =>
        c.query(`INSERT INTO ${TABLE} (org_id, body) VALUES ($1, 'x')`, [org]),
      ),
    );
    await withAppClient(async (c) => {
      await expect(
        c.query(`SELECT * FROM ${month(0).name}`),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await expect(
      asPartitionOwner([
        `UPDATE public.${month(0).name} SET body = 'y' WHERE org_id = '${org}'`,
      ]),
    ).rejects.toMatchObject({
      code: '42501',
      message: 'fixture_part_events is append-only',
    });
  });
  it('an unexpected partition name makes the function RAISE', async () => {
    await asPartitionOwner([
      `CREATE TABLE public.${TABLE}_odd (LIKE public.${TABLE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      `ALTER TABLE public.${TABLE} ATTACH PARTITION public.${TABLE}_odd FOR VALUES FROM ('2099-01-01T00:00:00Z') TO ('2099-02-01T00:00:00Z')`,
    ]);
    try {
      await withAppClient(async (c) => {
        await expect(maintain(c, RETENTION, PREMAKE)).rejects.toThrow(
          /unexpected partition fixture_part_events_odd/,
        );
      });
    } finally {
      await detach(`${TABLE}_odd`);
    }
  });
  it('ATTACH keeps the parent at SHARE UPDATE EXCLUSIVE: an INSERT runs while maintenance is open (lock level of spike P1)', async () => {
    await detach(month(PREMAKE).name);
    await withAppClient(async (a) => {
      await a.query('BEGIN');
      try {
        const pid = (
          await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]?.pid;
        expect((await maintain(a, RETENTION, PREMAKE)).rows).toEqual([
          { action: 'created', partition_name: month(PREMAKE).name },
        ]);
        const { rows } = await owner.query<{ mode: string }>(
          `SELECT l.mode FROM pg_locks l WHERE l.pid = $1 AND l.relation = 'public.${TABLE}'::regclass`,
          [pid],
        );
        expect(rows.map((r) => r.mode)).toContain('ShareUpdateExclusiveLock');
        expect(rows.map((r) => r.mode)).not.toContain('AccessExclusiveLock');
        const org = v7();
        await withAppClient((b) =>
          inOrgTx(b, org, async () => {
            await b.query(`SET LOCAL lock_timeout = '${PROBE_LOCK_TIMEOUT}'`);
            await b.query(`INSERT INTO ${TABLE} (org_id) VALUES ($1)`, [org]);
          }),
        );
        await a.query('COMMIT');
      } catch (err) {
        await a.query('ROLLBACK');
        throw err;
      }
    });
  });
  it('partition bounds are UTC month bounds whatever the session TimeZone (Review Focus 4)', async () => {
    await detach(month(PREMAKE).name);
    await withAppClient(async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
      await maintain(c, RETENTION, PREMAKE);
      await c.query('COMMIT');
    });
    await owner.query(`SET TimeZone = 'UTC'`);
    const { rows } = await owner.query<{ bound: string }>(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c WHERE c.relname = $1`,
      [month(PREMAKE).name],
    );
    const iso = (s: string) => s.replace('T', ' ').replace('.000Z', '+00');
    expect(rows[0]?.bound).toBe(
      `FOR VALUES FROM ('${iso(month(PREMAKE).lo)}') TO ('${iso(month(PREMAKE).hi)}')`,
    );
  });
  it('the cron handler maintains every entry in its own transaction; a failing entry does not stop the others; logs, counter and gauge', async () => {
    await detach(month(PREMAKE).name);
    const log = new Logger('partition-maintain-test');
    const info = vi.spyOn(log, 'log');
    const ctx: JobContext<unknown> = {
      payload: {},
      meta: {},
      jobId: 'test',
      attempt: 1,
      maxAttempts: 1,
      signal: new AbortController().signal,
      log,
    };
    await expect(
      app.get(MaintainPartitionsHandler).handle(ctx),
    ).rejects.toThrow(/fixture_missing_maintain; the other entries ran/);
    expect(await partitions()).toContain(month(PREMAKE).name);
    expect(info).toHaveBeenCalledWith(
      {
        event: 'partition_created',
        table: TABLE,
        partition: month(PREMAKE).name,
      },
      'partition created',
    );
    expect(
      await otel.metric('db_partition_maintain_total', {
        table: TABLE,
        action: 'created',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await otel.metric('db_partition_months_ahead', { table: TABLE }),
    ).toBe(PREMAKE);
    expect(otel.spanNames()).toContain('core.partitions.maintain');
  });
});
