import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  Injectable,
  Logger,
  Module,
  type INestApplication,
} from '@nestjs/common';
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
  JobPayloadError,
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
/** Tham số của bộ test: lease ngắn để test hết hạn lease không phải chờ lâu (luật: lease ≥ 2 × enqueue timeout). */
const CLAIM_LEASE_MS = 2000;
const ENQUEUE_TIMEOUT_MS = 1000;
const LEASE_EXPIRY_SLACK_MS = 300;
const MAX_PUBLISH_ATTEMPTS = 3;
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
    vi.stubEnv('OUTBOX_MAX_PUBLISH_ATTEMPTS', String(MAX_PUBLISH_ATTEMPTS));
    vi.stubEnv('OUTBOX_ATTEMPTS_ALERT_THRESHOLD', '2');
    vi.stubEnv('OUTBOX_CLAIM_LEASE_MS', String(CLAIM_LEASE_MS));
    vi.stubEnv('OUTBOX_ENQUEUE_TIMEOUT_MS', String(ENQUEUE_TIMEOUT_MS));
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
  const attemptsOf = async (eventId: string) =>
    (
      await app
        .get(RelayDb)
        .execute<{ publish_attempts: number }>(
          'SELECT publish_attempts FROM outbox_events WHERE event_id = ?',
          [eventId],
        )
    )[0]!.publish_attempts;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const leased = async (eventId: string) =>
    (
      await app
        .get(RelayDb)
        .execute<{ leased: boolean }>(
          'SELECT claimed_until IS NOT NULL AS leased FROM outbox_events WHERE event_id = ?',
          [eventId],
        )
    )[0]!.leased;
  /** Postgres nhận UUID này nhưng zod (RFC variant) từ chối: ghi thẳng, bỏ qua validate của writer. */
  const insertPoison = async () => {
    const bad = v7();
    await app.get(UnitOfWork).run(() =>
      app.get(Db).execute(
        `INSERT INTO outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
             VALUES (?, 'test.poison', 1, '11111111-1111-1111-1111-111111111111', 't', '1', 1, '{}'::jsonb, '{}'::jsonb)`,
        [bad],
      ),
    );
    return bad;
  };
  /** Park dòng hỏng để nó không lẫn vào các lô của test sau. */
  const park = (eventId: string) =>
    app
      .get(RelayDb)
      .execute(
        'UPDATE outbox_events SET publish_attempts = ?, claimed_until = NULL WHERE event_id = ?',
        [MAX_PUBLISH_ATTEMPTS, eventId],
      );

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
  it('app_user cannot update or delete outbox rows, nor read the inbox', async () => {
    await expect(
      app.get(Db).execute('UPDATE outbox_events SET published_at = now()'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.get(Db).execute('DELETE FROM outbox_events'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.get(Db).execute('SELECT event_id FROM processed_events LIMIT 1'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.get(Db).execute('SELECT consumer FROM processed_events LIMIT 1'),
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
    // Lỗi cả lô (transport) không quy cho dòng nào: không tăng publish_attempts, không park.
    expect(await attemptsOf(e.eventId)).toBe(0);
    await app.get(OutboxRelay).drain();
    await until(() => dispatched.length >= 1);
    const marker = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(marker));
    await app.get(OutboxRelay).drain();
    await until(() => dispatched.length >= 2);
    expect(dispatched).toHaveLength(2);
  });
  it('a relay that stalls after claiming holds its rows only until the lease expires; another relay then publishes them exactly once', async () => {
    const events = Array.from({ length: 3 }, () => evt());
    await app.get(UnitOfWork).run(async () => {
      for (const e of events) await app.get(OutboxWriter).append(e);
    });
    const ids = await Promise.all(events.map((e) => outboxId(e.eventId)));
    const relay = app.get(OutboxRelay);
    const hooks = app.get<OutboxRelayHooks>(OUTBOX_RELAY_HOOKS);
    let claimedByA = false;
    let resumeA!: () => void;
    // Relay A "chết" ngay sau khi claim (không enqueue, không đánh dấu), rồi sống lại muộn.
    hooks.afterClaim = () => {
      hooks.afterClaim = undefined;
      claimedByA = true;
      return new Promise<void>((r) => (resumeA = r));
    };
    const relayA = relay.runOnce();
    await until(() => claimedByA, 5000);
    // Lease còn hạn: relay B không lấy được dòng nào, dòng vẫn chưa publish.
    expect(await relay.runOnce()).toBe(0);
    for (const e of events) expect(await unpublished(e.eventId)).toBe('1');

    await sleep(CLAIM_LEASE_MS + LEASE_EXPIRY_SLACK_MS);
    expect(await relay.drain()).toBe(3);
    await until(() => ids.every((id) => dispatched.includes(id)));

    // A tỉnh lại: enqueue trùng jobId bị BullMQ bỏ qua, đánh dấu published là no-op.
    resumeA();
    expect(await relayA).toBe(0);
    await sleep(300);
    expect(dispatched.filter((d) => ids.includes(d)).sort()).toEqual(
      [...ids].sort(),
    );
  });
  it('a relay that lost its lease neither counts a poison row twice nor releases the lease of the relay that re-claimed it', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const relay = app.get(OutboxRelay);
    const hooks = app.get<OutboxRelayHooks>(OUTBOX_RELAY_HOOKS);
    const stall = () => {
      let resume!: () => void;
      let entered = false;
      const gate = new Promise<void>((r) => (resume = r));
      return {
        hook: () => {
          entered = true;
          return gate;
        },
        entered: () => entered,
        resume: () => resume(),
      };
    };

    // Dòng hỏng: A claim rồi treo, lease hết hạn, B claim và tăng attempts; A tỉnh lại không tăng nữa.
    const bad = await insertPoison();
    const a1 = stall();
    hooks.afterClaim = () => {
      hooks.afterClaim = undefined;
      return a1.hook();
    };
    const relayA1 = relay.runOnce();
    await until(a1.entered, 5000);
    await sleep(CLAIM_LEASE_MS + LEASE_EXPIRY_SLACK_MS);
    await relay.runOnce();
    expect(await attemptsOf(bad)).toBe(1);
    a1.resume();
    await relayA1;
    expect(await attemptsOf(bad)).toBe(1);
    expect(warnSpy.mock.calls.map((c) => c[1])).toContain(
      'outbox event rejected after this relay lost its lease; attempts are counted by the relay that owns it',
    );
    await park(bad);

    // Lô thất bại của A (lease đã hết) không được xoá lease B đang giữ.
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    const a2 = stall();
    hooks.afterClaim = async () => {
      hooks.afterClaim = undefined;
      await a2.hook();
      throw new Error('relay A failed after losing its lease');
    };
    const relayA2 = relay.runOnce();
    await until(a2.entered, 5000);
    await sleep(CLAIM_LEASE_MS + LEASE_EXPIRY_SLACK_MS);
    const b = stall();
    hooks.afterEnqueue = () => {
      hooks.afterEnqueue = undefined;
      return b.hook();
    };
    const relayB = relay.runOnce();
    await until(b.entered, 5000);
    a2.resume();
    await expect(relayA2).rejects.toThrow('relay A failed');
    expect(await leased(e.eventId)).toBe(true);
    b.resume();
    expect(await relayB).toBe(1);
    expect(await unpublished(e.eventId)).toBe('0');
    warnSpy.mockRestore();
  });
  it('an enqueue that completes after its timeout never marks the row, and blocks further enqueues until it settles', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const queue = app.get(JobQueue);
    const real = queue.enqueueMany.bind(queue);
    let letThrough!: () => void;
    const gate = new Promise<void>((r) => (letThrough = r));
    const spy = vi
      .spyOn(queue, 'enqueueMany')
      .mockImplementationOnce(async (items) => {
        await gate;
        return real(items);
      });
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    const id = await outboxId(e.eventId);
    const relay = app.get(OutboxRelay);

    await expect(relay.runOnce()).rejects.toThrow(/enqueue timed out/);
    expect(await unpublished(e.eventId)).toBe('1');
    expect(await leased(e.eventId)).toBe(false);
    // Lời gọi cũ còn treo: lô sau thất bại ngay, không gọi thêm vào Redis, không tăng attempts.
    await expect(relay.runOnce()).rejects.toThrow(/still pending/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await attemptsOf(e.eventId)).toBe(0);

    letThrough();
    await until(() => dispatched.includes(id));
    await until(() =>
      warnSpy.mock.calls.some(
        (c) =>
          c[1] ===
          'outbox enqueue completed after its timeout; the retried jobs are deduplicated by jobId',
      ),
    );
    expect(await unpublished(e.eventId)).toBe('1');

    expect(await relay.drain()).toBe(1);
    await sleep(300);
    expect(dispatched.filter((d) => d === id)).toHaveLength(1);
    spy.mockRestore();
    warnSpy.mockRestore();
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
  it('stop() waits for a batch that is mid-flight before resolving', async () => {
    const relay = app.get(OutboxRelay);
    const hooks = app.get<OutboxRelayHooks>(OUTBOX_RELAY_HOOKS);
    let release!: () => void;
    let entered!: () => void;
    const enteredBatch = new Promise<void>((r) => (entered = r));
    hooks.afterEnqueue = () => {
      hooks.afterEnqueue = undefined;
      entered();
      return new Promise<void>((r) => (release = r));
    };
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    relay.start();
    await enteredBatch;
    let stopped = false;
    const stopping = relay.stop().then(() => {
      stopped = true;
    });
    await sleep(150);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await unpublished(e.eventId)).toBe('0');
  });
  it('writer rejects values the relay could never publish', async () => {
    await expect(
      app.get(UnitOfWork).run(() =>
        app.get(OutboxWriter).append({
          ...evt(),
          orgId: '11111111-1111-1111-1111-111111111111',
        }),
      ),
    ).rejects.toThrow(/orgId/);
  });
  it('a poison row is counted, logged, parked at max attempts and never blocks good rows', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    const bad = v7();
    // Postgres nhận UUID này nhưng zod (RFC variant) từ chối: ghi thẳng, bỏ qua validate của writer.
    await app.get(UnitOfWork).run(() =>
      app.get(Db).execute(
        `INSERT INTO outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
             VALUES (?, 'test.poison', 1, '11111111-1111-1111-1111-111111111111', 't', '1', 1, '{}'::jsonb, '{}'::jsonb)`,
        [bad],
      ),
    );
    const good = Array.from({ length: 6 }, () => evt());
    await app.get(UnitOfWork).run(async () => {
      for (const e of good) await app.get(OutboxWriter).append(e);
    });
    const relay = app.get(OutboxRelay);
    expect(await relay.drain()).toBe(6);
    for (const e of good) expect(await unpublished(e.eventId)).toBe('0');
    // Dòng hỏng đứng đầu lô và bị loại; lô sau của cùng drain có thể claim lại nó (đã mở khoá).
    expect(await attemptsOf(bad)).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 3 && (await attemptsOf(bad)) < 3; i++)
      await relay.drain();
    expect(await attemptsOf(bad)).toBe(3);
    await relay.drain();
    expect(await attemptsOf(bad)).toBe(3);
    expect(await unpublished(bad)).toBe('1');
    const later = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(later));
    expect(await relay.drain()).toBe(1);
    const messages = errorSpy.mock.calls.map((c) => c[1]);
    expect(messages).toContain('outbox event keeps failing to publish');
    expect(messages).toContain(
      'outbox event parked after max publish attempts',
    );
    errorSpy.mockRestore();
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
  it('SafeEnqueue fallback keeps opts.meta so the relayed job runs with the same orgId', async () => {
    const orgId = v7();
    const spy = vi
      .spyOn(app.get(JobQueue), 'enqueueDynamic')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await app
      .get(SafeEnqueue)
      .enqueue(
        Probe,
        { n: 43 },
        { meta: { orgId, requestId: 'req-fallback' } },
      );
    spy.mockRestore();
    const rows = await app.get(RelayDb).execute<{
      id: string;
      org_id: string;
      headers: Record<string, string>;
    }>(`SELECT id::text AS id, org_id::text AS org_id, headers FROM outbox_events WHERE type = 'core.job.deferred' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]!.org_id).toBe(orgId);
    expect(rows[0]!.headers.correlationId).toBe('req-fallback');
    await app.get(OutboxRelay).drain();
    const id = rows[0]!.id;
    await until(() => dispatchedMeta.has(id));
    expect(dispatchedMeta.get(id)).toMatchObject({
      orgId,
      requestId: 'req-fallback',
    });
  });
  it('SafeEnqueue rejects an invalid jobId on both paths instead of deferring it', async () => {
    const safe = app.get(SafeEnqueue);
    for (const jobId of ['invoice:42', '42']) {
      await expect(safe.enqueue(Probe, { n: 1 }, { jobId })).rejects.toThrow(
        JobPayloadError,
      );
      await expect(
        app.get(UnitOfWork).run(() => safe.enqueue(Probe, { n: 1 }, { jobId })),
      ).rejects.toThrow(JobPayloadError);
    }
    const rows = await app
      .get(RelayDb)
      .execute(
        `SELECT 1 FROM outbox_events WHERE type = 'core.job.deferred' AND payload->>'jobId' IN ('invoice:42', '42')`,
      );
    expect(rows).toHaveLength(0);
  });
  it('SafeEnqueue does not defer invalid payloads', async () => {
    await expect(
      app
        .get(SafeEnqueue)
        .enqueue(Probe, { n: 'x' } as unknown as { n: number }),
    ).rejects.toThrow(/payload/i);
  });
});
