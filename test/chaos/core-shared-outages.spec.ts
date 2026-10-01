import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ConfigOf } from '../../src/core/config/index.js';
import {
  DatabaseModule,
  databaseConfig,
} from '../../src/core/database/index.js';
import {
  FlagsModule,
  KillSwitches,
  defineKillSwitch,
} from '../../src/core/flags/index.js';
import { createTestApp } from '../support/app-factory.js';
import { getInfra } from '../support/infra.js';
import { installOtelCapture } from '../support/otel-capture.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { inOrgTx, withAppClient } from '../support/tenancy-seed.js';

const otel = installOtelCapture();
const SWITCH = defineKillSwitch({
  key: 'fixture.chaos_switch',
  description: 'chaos probe',
});
const INTERVAL_MS = 1000;
/** isKilled đọc snapshot trong bộ nhớ: phải trả lời gần như tức thì kể cả khi DB treo. */
const READ_BOUND_MS = 100;
/**
 * Hàm bảo trì mang `lock_timeout` 5 s (thuộc tính hàm): mỗi lượt dưới tải phải xong dưới mốc này; `withAppClient` gọi bằng
 * `app_user` nên `statement_timeout` của role (compose 5000) cũng bằng mốc này (ADR 0020 P1).
 */
const LOCK_TIMEOUT_MS = 5000;
const WRITERS = 4;
const MAINTAIN_ROUNDS = 5;
const TABLE = 'fixture_part_events';
const month = (offset: number) => {
  const now = new Date();
  const lo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
  const hi = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1),
  );
  return {
    name: `${TABLE}_p${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`,
    lo: lo.toISOString(),
    hi: hi.toISOString(),
  };
};

describe('kill switch refresh while the DB is blackholed (spec SP6 criterion 11, C-30)', () => {
  let app: INestApplication;
  let proxy: TcpProxy;
  let owner: pg.Client;
  let queryTimeoutMs = 0;
  const crashes: unknown[] = [];
  const onCrash = (err: unknown) => crashes.push(err);
  const setRow = (killed: boolean) =>
    owner.query(
      `INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES ($1, $2, $3, 'chaos')
       ON CONFLICT (key) DO UPDATE SET killed = EXCLUDED.killed, reason = EXCLUDED.reason, version = kill_switches.version + 1, updated_at = now()`,
      [SWITCH.key, killed, killed ? 'chaos' : null],
    );
  beforeAll(async () => {
    process.on('unhandledRejection', onCrash);
    process.on('uncaughtException', onCrash);
    const infra = getInfra();
    owner = new pg.Client({
      host: infra.pg.host,
      port: infra.pg.port,
      database: infra.pg.database,
      ...infra.pg.owner,
    });
    await owner.connect();
    await setRow(true);
    proxy = await startTcpProxy(infra.pgbouncer.host, infra.pgbouncer.port);
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_PORT', String(proxy.port));
    vi.stubEnv('FLAGS_REFRESH_INTERVAL_MS', String(INTERVAL_MS));
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      FlagsModule,
    ]);
    queryTimeoutMs = app.get<ConfigOf<typeof databaseConfig>>(
      databaseConfig.KEY,
    ).queryTimeoutMs;
  });
  afterAll(async () => {
    await proxy?.close();
    await app?.close();
    await owner?.query('DELETE FROM kill_switches WHERE key = $1', [
      SWITCH.key,
    ]);
    await owner?.end();
    vi.unstubAllEnvs();
    process.off('unhandledRejection', onCrash);
    process.off('uncaughtException', onCrash);
  });

  it('keeps answering from the last snapshot, counts failed refreshes, and picks up the new value once the DB is back', async () => {
    const switches = app.get(KillSwitches);
    expect(await switches.isKilled(SWITCH.key)).toBe(true);
    const before = (await otel.metric('flags_refresh_failures_total')) ?? 0;
    proxy.state.blackhole = true;
    await vi.waitFor(
      async () =>
        expect(
          await otel.metric('flags_refresh_failures_total'),
        ).toBeGreaterThan(before),
      {
        timeout: queryTimeoutMs * 2 + INTERVAL_MS * 2,
        interval: 100,
      },
    );
    const t = performance.now();
    expect(await switches.isKilled(SWITCH.key)).toBe(true);
    expect(performance.now() - t).toBeLessThan(READ_BOUND_MS);
    await setRow(false);
    proxy.state.blackhole = false;
    proxy.sever();
    await vi.waitFor(
      async () => expect(await switches.isKilled(SWITCH.key)).toBe(false),
      {
        timeout: queryTimeoutMs + INTERVAL_MS * 3,
        interval: 100,
      },
    );
    expect(crashes).toEqual([]);
  });
});

describe('partition maintenance under concurrent inserts (C-30, R6-17, R60-7)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => owner?.end());
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

  it('each round attaches and drops months without deadlock, under lock_timeout, while every insert succeeds', async () => {
    let stop = false;
    let inserted = 0;
    const errors: unknown[] = [];
    const writers = Array.from({ length: WRITERS }, () =>
      withAppClient(async (c) => {
        const org = v7();
        while (!stop) {
          try {
            await inOrgTx(c, org, () =>
              c.query(
                `INSERT INTO ${TABLE} (org_id, body) VALUES ($1, 'load')`,
                [org],
              ),
            );
            inserted++;
          } catch (err) {
            errors.push(err);
          }
        }
      }),
    );
    const rounds: number[] = [];
    try {
      for (let i = 0; i < MAINTAIN_ROUNDS; i++) {
        const old = month(-3);
        const ahead = month(3);
        await asPartitionOwner([
          `CREATE TABLE public.${old.name} (LIKE public.${TABLE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
          `ALTER TABLE public.${TABLE} ATTACH PARTITION public.${old.name} FOR VALUES FROM ('${old.lo}') TO ('${old.hi}')`,
          `ALTER TABLE public.${TABLE} DETACH PARTITION public.${ahead.name}`,
          `DROP TABLE public.${ahead.name}`,
        ]);
        const t = performance.now();
        const { rows } = await withAppClient((c) =>
          c.query(
            'SELECT action, partition_name FROM fixture_part_events_maintain(1, 3)',
          ),
        );
        rounds.push(performance.now() - t);
        expect(rows).toEqual(
          expect.arrayContaining([
            { action: 'created', partition_name: ahead.name },
            { action: 'dropped', partition_name: old.name },
          ]),
        );
      }
    } finally {
      stop = true;
      await Promise.all(writers);
    }
    console.log(
      JSON.stringify({
        chaos: 'partition-maintain-under-load',
        rounds,
        inserted,
      }),
    );
    expect(errors).toEqual([]);
    expect(inserted).toBeGreaterThan(0);
    for (const ms of rounds) expect(ms).toBeLessThan(LOCK_TIMEOUT_MS);
  });
});
