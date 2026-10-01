import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v5, v7 } from 'uuid';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  EventPublisher,
  EventsModule,
  defineEvent,
} from '../../../../src/core/events/index.js';
import {
  OutboxModule,
  OutboxWriter,
  type NewOutboxEvent,
} from '../../../../src/core/outbox/index.js';
import { QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';

const FixtureHappened = defineEvent({
  type: 'test.fixture.registered',
  version: 1,
  audit: false,
  webhook: false,
  schema: z.object({ id: z.string() }),
});
const event = (eventId: string): NewOutboxEvent => ({
  eventId,
  type: 'test.fixture.happened',
  version: 1,
  orgId: null,
  aggregate: { type: 'fixture', id: 'a1', version: 1 },
  payload: {},
  headers: {},
});
/** Số lần ghi đồng thời cùng một event id trong test tranh chấp. */
const CONCURRENT_WRITERS = 8;

describe('idempotent event writes (as app_user)', () => {
  let app: INestApplication;
  let owner: pg.Client;
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }),
      EventsModule.forRoot({ worker: false }),
    ]);
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  /** Event id mà test đã ghi (mọi test đều đếm id của mình qua `count`). */
  const written = new Set<string>();
  afterAll(async () => {
    // Relay không chạy ở đây nên dòng của file này còn chưa publish; xoá đi để relay của spec khác
    // (vd. outbox.spec, drain ở beforeEach) không phải dispatch event lạ của file này.
    try {
      if (owner && written.size > 0)
        await owner.query(
          'DELETE FROM outbox_events WHERE event_id = ANY($1::uuid[])',
          [[...written]],
        );
    } finally {
      await owner?.end();
      await app?.close();
    }
  });

  const count = async (id: string) => {
    written.add(id);
    return (
      await owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbox_events WHERE event_id = $1',
        [id],
      )
    ).rows[0]!.n;
  };

  it('OutboxWriter: a second append with the same event id is a no-op', async () => {
    const id = v7();
    const uow = app.get(UnitOfWork);
    const outbox = app.get(OutboxWriter);
    await uow.run(() => outbox.append(event(id), { ifAbsent: true }));
    await uow.run(() => outbox.append(event(id), { ifAbsent: true }));
    expect(await count(id)).toBe(1);
  });
  it('OutboxWriter: without ifAbsent a duplicate still fails loudly (23505)', async () => {
    const id = v7();
    const uow = app.get(UnitOfWork);
    const outbox = app.get(OutboxWriter);
    await uow.run(() => outbox.append(event(id)));
    await expect(uow.run(() => outbox.append(event(id)))).rejects.toThrow(
      /duplicate key|unique/i,
    );
    expect(await count(id)).toBe(1);
  });
  it('EventPublisher: a predetermined (v5) event id is kept and deduplicated with ifAbsent', async () => {
    const id = v5(`test.fixture.registered:${v7()}`, v5.URL);
    const uow = app.get(UnitOfWork);
    const pub = app.get(EventPublisher);
    const input = {
      eventId: id,
      data: { id: 'x' },
      aggregate: { type: 'fixture', id: 'x', version: 1 },
      actor: { type: 'system' as const, id: 'test' },
    };
    expect(
      await uow.run(() =>
        pub.publish(FixtureHappened, input, { ifAbsent: true }),
      ),
    ).toBe(id);
    await uow.run(() =>
      pub.publish(FixtureHappened, input, { ifAbsent: true }),
    );
    expect(await count(id)).toBe(1);
  });

  // Tranh chấp thật: các transaction mở song song cùng chèn một event id. UNIQUE(event_id) +
  // ON CONFLICT DO NOTHING là cơ chế chống trùng (không có check-then-insert): transaction đến sau
  // chờ transaction đang giữ khoá của index, thấy dòng đã commit thì bỏ qua thay vì ném 23505.
  it('OutboxWriter: concurrent ifAbsent appends of the same event id all succeed and write one row (read committed)', async () => {
    const id = v7();
    const uow = app.get(UnitOfWork);
    const outbox = app.get(OutboxWriter);
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_WRITERS }, () =>
        uow.run(() => outbox.append(event(id), { ifAbsent: true })),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await count(id)).toBe(1);
  });
  // Dưới snapshot của cả transaction, dòng xung đột do transaction đồng thời commit không nhìn thấy
  // được nên Postgres ném 40001 thay vì bỏ qua; UnitOfWork chạy lại transaction và lần sau là no-op.
  it('EventPublisher: concurrent ifAbsent publishes of the same v5 id converge on one row (serializable)', async () => {
    const id = v5(`test.fixture.registered:${v7()}`, v5.URL);
    const uow = app.get(UnitOfWork);
    const pub = app.get(EventPublisher);
    const input = {
      eventId: id,
      data: { id: 'x' },
      aggregate: { type: 'fixture', id: 'x', version: 1 },
      actor: { type: 'system' as const, id: 'test' },
    };
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_WRITERS }, () =>
        uow.run(() => pub.publish(FixtureHappened, input, { ifAbsent: true }), {
          isolation: 'serializable',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(
      results.map((r) => (r.status === 'fulfilled' ? r.value : undefined)),
    ).toEqual(Array(CONCURRENT_WRITERS).fill(id));
    expect(await count(id)).toBe(1);
  });
});
