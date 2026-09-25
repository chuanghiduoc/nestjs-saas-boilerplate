import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
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
/** Đủ để hai unit chạy xen kẽ: unit A truy vấn lại sau khi unit B đã bind EM của nó. */
const CONCURRENCY_DELAY_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const txid = async (db: Db): Promise<string> =>
  (await db.execute<{ id: string }>('SELECT txid_current()::text AS id'))[0]!
    .id;

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

  it('statements inside the unit share one transaction (same txid), outside they do not', async () => {
    const inside = await uow.run(async () => [await txid(db), await txid(db)]);
    expect(inside[0]).toBe(inside[1]);
    expect(await txid(db)).not.toBe(await txid(db));
  });

  describe('inside an active CLS context (production path)', () => {
    let cls: ClsService;
    beforeAll(() => {
      cls = app.get(ClsService);
    });

    it('leaves no transactional EM bound after run completes', async () => {
      await cls.run(async () => {
        expect(txEm.current()).toBeUndefined();
        const seen = await uow.run(async () => {
          const em = txEm.get();
          return { inTx: em.isInTransaction(), em };
        });
        expect(seen.inTx).toBe(true);
        expect(txEm.current()).toBeUndefined();
        expect(uow.inTransaction()).toBe(false);
      });
    });

    it('concurrent runs in one CLS context use separate transactions', async () => {
      const unit = () =>
        uow.run(async () => {
          const first = await txid(db);
          await sleep(CONCURRENCY_DELAY_MS);
          return { first, second: await txid(db) };
        });
      const [a, b] = await cls.run(() => Promise.all([unit(), unit()]));
      expect(a!.first).toBe(a!.second);
      expect(b!.first).toBe(b!.second);
      expect(a!.first).not.toBe(b!.first);
    });

    it('run on a pre-bound non-transactional fork starts a transaction and restores the bound EM', async () => {
      await cls.run(async () => {
        const outer = txEm.fork();
        await txEm.bind(outer, async () => {
          expect(txEm.current()).toBe(outer);
          expect(uow.inTransaction()).toBe(false);
          const inner = await uow.run(async () => {
            expect(uow.inTransaction()).toBe(true);
            return txEm.get();
          });
          // Fork transaction của MikroORM vẫn giữ tham chiếu transaction đã commit, nên nó
          // tuyệt đối không được còn gắn trong context sau khi run kết thúc.
          expect(inner).not.toBe(outer);
          expect(txEm.current()).toBe(outer);
          expect(uow.inTransaction()).toBe(false);
          expect(outer.isInTransaction()).toBe(false);
        });
        expect(txEm.current()).toBeUndefined();
      });
    });
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
