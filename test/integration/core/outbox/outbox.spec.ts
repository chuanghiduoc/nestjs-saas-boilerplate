import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { z } from 'zod';
import {
  DatabaseModule,
  Db,
  RelayDb,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  DispatchEventJob,
  EventsQueue,
  Inbox,
  OUTBOX_RELAY_HOOKS,
  OutboxModule,
  OutboxRelay,
  OutboxWriter,
  SafeEnqueue,
  type NewOutboxEvent,
  type OutboxRelayHooks,
} from '../../../../src/core/outbox/index.js';
import {
  JobHandler,
  JobQueue,
  QueueModule,
  defineJob,
  type JobContext,
  type JobMeta,
} from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const dispatched: string[] = [];
const dispatchedMeta = new Map<string, JobMeta>();
const probed: number[] = [];
const Probe = defineJob({
  name: 'test.outbox.probe',
  queue: EventsQueue,
  version: 1,
  schema: z.object({ n: z.number() }),
});

@Injectable()
@JobHandler(DispatchEventJob)
class DispatchSpy {
  async handle(ctx: JobContext<{ outboxId: string }>) {
    dispatched.push(ctx.payload.outboxId);
    dispatchedMeta.set(ctx.payload.outboxId, ctx.meta);
  }
}
/** WorkerHost bắt buộc mọi job trên queue được consume phải có handler (Task 8). */
@Injectable()
@JobHandler(Probe)
class ProbeSpy {
  async handle(ctx: JobContext<{ n: number }>) {
    probed.push(ctx.payload.n);
  }
}
@Module({ providers: [DispatchSpy, ProbeSpy] })
class Spies {}

const evt = (headers: Record<string, string> = {}): NewOutboxEvent => ({
  eventId: v7(),
  type: 'test.thing.happened',
  version: 1,
  orgId: null,
  aggregate: { type: 'thing', id: '1', version: 1 },
  payload: { a: 1 },
  headers,
});
const until = async (pred: () => boolean | Promise<boolean>, ms = 15000) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('outbox', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'events');
    vi.stubEnv('OUTBOX_AUTOSTART', 'false');
    vi.stubEnv('OUTBOX_BATCH_SIZE', '5');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '50');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      Spies,
    ]);
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    dispatched.length = 0;
    await app.get(OutboxRelay).drain();
    dispatched.length = 0;
  });

  const unpublished = async (id: string) =>
    (
      await app
        .get(RelayDb)
        .execute<{ n: string }>(
          'SELECT count(*)::text AS n FROM outbox_events WHERE event_id = ? AND published_at IS NULL',
          [id],
        )
    )[0]!.n;
  const outboxId = async (eventId: string) =>
    (
      await app
        .get(RelayDb)
        .execute<{ id: string }>(
          'SELECT id::text AS id FROM outbox_events WHERE event_id = ?',
          [eventId],
        )
    )[0]!.id;

  it('append outside a unit of work throws', async () => {
    await expect(app.get(OutboxWriter).append(evt())).rejects.toThrow(
      /UnitOfWork/,
    );
  });
  it('app_user cannot read outbox payloads', async () => {
    await expect(
      app.get(Db).execute('SELECT payload FROM outbox_events LIMIT 1'),
    ).rejects.toThrow(/permission denied/);
  });
  it('app_user cannot update or delete outbox rows, nor read inbox beyond the consumer column', async () => {
    await expect(
      app.get(Db).execute('UPDATE outbox_events SET published_at = now()'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.get(Db).execute('DELETE FROM outbox_events'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.get(Db).execute('SELECT event_id FROM processed_events LIMIT 1'),
    ).rejects.toThrow(/permission denied/);
  });
  it('rolled back transaction leaves no event', async () => {
    const e = evt();
    await expect(
      app.get(UnitOfWork).run(async () => {
        await app.get(OutboxWriter).append(e);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(
      await app
        .get(RelayDb)
        .execute('SELECT 1 FROM outbox_events WHERE event_id = ?', [e.eventId]),
    ).toHaveLength(0);
  });
  it('relay publishes committed events exactly once', async () => {
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    expect(await app.get(OutboxRelay).drain()).toBe(1);
    await until(() => dispatched.length === 1);
    expect(await app.get(OutboxRelay).drain()).toBe(0);
  });
  it('relay propagates the event correlation id and traceparent into the job meta', async () => {
    const traceparent =
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const e = evt({ correlationId: 'req-outbox-meta', traceparent });
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    await app.get(OutboxRelay).drain();
    const id = await outboxId(e.eventId);
    await until(() => dispatchedMeta.has(id));
    expect(dispatchedMeta.get(id)).toMatchObject({
      requestId: 'req-outbox-meta',
      traceparent,
    });
  });
  it('concurrent relays with small batch never publish the same row twice', async () => {
    const events = Array.from({ length: 50 }, () => evt());
    await app.get(UnitOfWork).run(async () => {
      for (const e of events) await app.get(OutboxWriter).append(e);
    });
    const relay = app.get(OutboxRelay);
    const counts = await Promise.all([
      relay.drain(),
      relay.drain(),
      relay.drain(),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(50);
    expect(counts.filter((c) => c > 0).length).toBeGreaterThan(1);
    await until(() => dispatched.length >= 50);
    expect(new Set(dispatched).size).toBe(dispatched.length);
  });
  it('enqueue-then-commit-failure: row stays unpublished, retry dispatches once', async () => {
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    const hooks = app.get<OutboxRelayHooks>(OUTBOX_RELAY_HOOKS);
    hooks.afterEnqueue = async () => {
      hooks.afterEnqueue = undefined;
      throw new Error('commit lost');
    };
    await expect(app.get(OutboxRelay).runOnce()).rejects.toThrow('commit lost');
    expect(await unpublished(e.eventId)).toBe('1');
    const attempts = await app
      .get(RelayDb)
      .execute<{ publish_attempts: number }>(
        'SELECT publish_attempts FROM outbox_events WHERE event_id = ?',
        [e.eventId],
      );
    expect(attempts[0]!.publish_attempts).toBe(1);
    await app.get(OutboxRelay).drain();
    await until(() => dispatched.length >= 1);
    const marker = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(marker));
    await app.get(OutboxRelay).drain();
    await until(() => dispatched.length >= 2);
    expect(dispatched).toHaveLength(2);
  });
  it('start() polls until stop(); stop() waits for the in-flight batch and leaves no timer running', async () => {
    const relay = app.get(OutboxRelay);
    const e = evt();
    relay.start();
    expect(() => relay.start()).toThrow(/already running/);
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    const id = await outboxId(e.eventId);
    await until(() => dispatched.includes(id));
    await relay.stop();
    const after = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(after));
    await new Promise((r) => setTimeout(r, 300));
    expect(await unpublished(after.eventId)).toBe('1');
  });
  it('inbox runs side effect once per consumer+event, and failure rolls back the record', async () => {
    const inbox = app.get(Inbox);
    const uow = app.get(UnitOfWork);
    const id = v7();
    let n = 0;
    const results = [
      await uow.run(() =>
        inbox.once('c1', id, async () => {
          n++;
        }),
      ),
      await uow.run(() =>
        inbox.once('c1', id, async () => {
          n++;
        }),
      ),
      await uow.run(() =>
        inbox.once('c2', id, async () => {
          n++;
        }),
      ),
    ];
    expect(results).toEqual(['processed', 'duplicate', 'processed']);
    expect(n).toBe(2);
    const id2 = v7();
    await expect(
      uow.run(() =>
        inbox.once('c3', id2, async () => {
          throw new Error('side effect failed');
        }),
      ),
    ).rejects.toThrow();
    expect(await uow.run(() => inbox.once('c3', id2, async () => {}))).toBe(
      'processed',
    );
  });
  it('inbox under concurrent duplicate delivery runs the side effect exactly once', async () => {
    const inbox = app.get(Inbox);
    const uow = app.get(UnitOfWork);
    const id = v7();
    let n = 0;
    const deliver = () =>
      uow.run(() =>
        inbox.once('c-concurrent', id, async () => {
          n++;
          await new Promise((r) => setTimeout(r, 200));
        }),
      );
    const results = await Promise.all([deliver(), deliver(), deliver()]);
    expect([...results].sort()).toEqual([
      'duplicate',
      'duplicate',
      'processed',
    ]);
    expect(n).toBe(1);
  });
  it('inbox outside a unit of work throws', async () => {
    await expect(
      app.get(Inbox).once('c1', v7(), async () => {}),
    ).rejects.toThrow(/UnitOfWork/);
  });
  it('SafeEnqueue inside a transaction always writes the outbox and never calls Redis directly', async () => {
    const spy = vi.spyOn(app.get(JobQueue), 'enqueueDynamic');
    await app
      .get(UnitOfWork)
      .run(() => app.get(SafeEnqueue).enqueue(Probe, { n: 1 }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const rows = await app
      .get(RelayDb)
      .execute<{ payload: { job: string; jobId: string } }>(
        `SELECT payload FROM outbox_events WHERE type = 'core.job.deferred' ORDER BY id DESC LIMIT 1`,
      );
    expect(rows[0]!.payload.job).toBe('test.outbox.probe');
    expect(rows[0]!.payload.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('SafeEnqueue outside a transaction enqueues directly and writes no outbox row', async () => {
    const before = await app
      .get(RelayDb)
      .execute<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_events WHERE type = 'core.job.deferred'`,
      );
    await app.get(SafeEnqueue).enqueue(Probe, { n: 7 });
    await until(() => probed.includes(7));
    const after = await app
      .get(RelayDb)
      .execute<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_events WHERE type = 'core.job.deferred'`,
      );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
  it('SafeEnqueue outside a transaction falls back to the outbox with the same jobId', async () => {
    const spy = vi
      .spyOn(app.get(JobQueue), 'enqueueDynamic')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await app.get(SafeEnqueue).enqueue(Probe, { n: 42 });
    const attemptedJobId = spy.mock.calls[0]![2]!.jobId;
    spy.mockRestore();
    const rows = await app
      .get(RelayDb)
      .execute<{ payload: { jobId: string; payload: { n: number } } }>(
        `SELECT payload FROM outbox_events WHERE type = 'core.job.deferred' ORDER BY id DESC LIMIT 1`,
      );
    expect(rows[0]!.payload).toMatchObject({
      jobId: attemptedJobId,
      payload: { n: 42 },
    });
  });
  it('SafeEnqueue does not defer invalid payloads', async () => {
    await expect(
      app
        .get(SafeEnqueue)
        .enqueue(Probe, { n: 'x' } as unknown as { n: number }),
    ).rejects.toThrow(/payload/i);
  });
});
