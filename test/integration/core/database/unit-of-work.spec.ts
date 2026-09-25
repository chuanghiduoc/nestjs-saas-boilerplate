import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import {
  DatabaseModule,
  Db,
  RelayDb,
  TxEm,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  FixtureModule,
  FixtureRepo,
} from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const STATEMENT_TIMEOUT_SQL =
  "SELECT current_setting('statement_timeout') AS t";

/*
 * @mikro-orm/nestjs giữ danh sách contextName ở mức module (CONTEXT_NAMES) và ném
 * "ContextName 'app' already registered" nếu hai app cùng mở context `app` trong một
 * process; danh sách được xoá khi app đóng. Vì vậy app api và app worker chạy tuần tự
 * trong hai describe, không mở song song.
 */
describe('UnitOfWork + Db (api role)', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let repo: FixtureRepo;
  let db: Db;
  let txEm: TxEm;
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      FixtureModule,
    ]);
    uow = app.get(UnitOfWork);
    repo = app.get(FixtureRepo);
    db = app.get(Db);
    txEm = app.get(TxEm);
  });
  afterAll(async () => {
    await app.close();
  });

  it('commits all writes when fn resolves', async () => {
    const body = `commit-${Date.now()}`;
    await uow.run(() => repo.insertSystemNote(body));
    expect(await repo.countSystemNotes(body)).toBe(1);
  });

  it('rolls back every write in the unit when fn throws', async () => {
    const body = `rollback-${Date.now()}`;
    await expect(
      uow.run(async () => {
        await repo.insertSystemNote(body);
        await repo.insertSystemNote(body);
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(await repo.countSystemNotes(body)).toBe(0);
  });

  it('nested run joins the outer transaction', async () => {
    const body = `nested-${Date.now()}`;
    await expect(
      uow.run(async () => {
        await uow.run(() => repo.insertSystemNote(body));
        throw new Error('outer');
      }),
    ).rejects.toThrow('outer');
    expect(await repo.countSystemNotes(body)).toBe(0);
  });

  it('statements inside the unit share one connection (same backend pid)', async () => {
    const pids = await uow.run(async () => {
      const a = await db.execute<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const b = await db.execute<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      return [a[0]!.pid, b[0]!.pid];
    });
    expect(pids[0]).toBe(pids[1]);
  });

  it('applies the requested isolation level to the transaction', async () => {
    const level = await uow.run(
      async () =>
        (
          await db.execute<{ l: string }>(
            "SELECT current_setting('transaction_isolation') AS l",
          )
        )[0]!.l,
      { isolation: 'serializable' },
    );
    expect(level).toBe('serializable');
  });

  it('rejects an isolation request on a nested run instead of silently ignoring it', async () => {
    await expect(
      uow.run(() => uow.run(async () => 1, { isolation: 'serializable' })),
    ).rejects.toThrow(/outermost/);
  });

  it('reports inTransaction only inside run, and TxEm.get throws outside', async () => {
    expect(uow.inTransaction()).toBe(false);
    expect(() => txEm.get()).toThrow(/No EntityManager in context/);
    expect(await uow.run(async () => uow.inTransaction())).toBe(true);
  });

  it('runs as app_user through PgBouncer with the role statement_timeout', async () => {
    const [row] = await db.execute<{ u: string; t: string }>(
      "SELECT current_user AS u, current_setting('statement_timeout') AS t",
    );
    expect(row!.u).toBe('app_user');
    expect(row!.t).not.toBe('0');
  });
});

describe('RelayDb (relay connection)', () => {
  let app: INestApplication;
  let relay: RelayDb;
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: true })]);
    relay = app.get(RelayDb);
  });
  afterAll(async () => {
    await app.close();
  });

  it('runs as app_relay', async () => {
    const [row] = await relay.execute<{ u: string }>(
      'SELECT current_user AS u',
    );
    expect(row!.u).toBe('app_relay');
  });

  it('transaction runs every statement in one transaction', async () => {
    const seen = await relay.transaction(async (tx) => {
      await tx.execute("SELECT set_config('app.relay_probe', 'x', true)");
      return (
        await tx.execute<{ v: string }>(
          "SELECT current_setting('app.relay_probe', true) AS v",
        )
      )[0]!.v;
    });
    expect(seen).toBe('x');
  });
});

describe('UnitOfWork (worker role)', () => {
  let worker: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    worker = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      FixtureModule,
    ]);
  });
  afterAll(async () => {
    await worker.close();
    vi.unstubAllEnvs();
  });

  it('applies its longer statement_timeout inside transactions only', async () => {
    const db = worker.get(Db);
    const inside = await worker
      .get(UnitOfWork)
      .run(
        async () =>
          (await db.execute<{ t: string }>(STATEMENT_TIMEOUT_SQL))[0]!.t,
      );
    const outside = (await db.execute<{ t: string }>(STATEMENT_TIMEOUT_SQL))[0]!
      .t;
    expect(inside).not.toBe(outside);
    expect(outside).not.toBe('0');
  });
});
