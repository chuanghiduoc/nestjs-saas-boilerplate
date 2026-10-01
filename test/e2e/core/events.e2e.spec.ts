import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { z } from 'zod';
import { RequestContext } from '../../../src/core/context/index.js';
import {
  DatabaseModule,
  Db,
  OrgScope,
  RelayDb,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import {
  DeliverEventJob,
  EventPublisher,
  EventSubscriber,
  EventsModule,
  defineEvent,
  type EventEnvelope,
} from '../../../src/core/events/index.js';
import {
  DispatchEventJob,
  OutboxModule,
  OutboxRelay,
  OutboxWriter,
  SafeEnqueue,
} from '../../../src/core/outbox/index.js';
import {
  JobHandler,
  JobQueue,
  QueueModule,
  defineJob,
  type JobContext,
} from '../../../src/core/queue/index.js';
import { BullmqJobQueue } from '../../../src/core/queue/bullmq-job-queue.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { FixtureNotesModule } from '../../fixtures/fixture.controller.js';
import { FixtureQueue, fixtureHandlers } from '../../fixtures/fixture.jobs.js';
import {
  AuditSubscriber,
  MailerSubscriber,
  NoteCreated,
  failOnce,
  received,
} from '../../fixtures/fixture.events.js';
import { createTestApp } from '../../support/app-factory.js';

const DeferredProbe = defineJob({
  name: 'fixture.deferred.probe',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ n: z.number() }),
});
const deferredRuns: number[] = [];
@Injectable()
@JobHandler(DeferredProbe)
class DeferredProbeHandler {
  async handle(ctx: JobContext<{ n: number }>) {
    deferredRuns.push(ctx.payload.n);
  }
}

/** Chuỗi event: subscriber phát event tiếp theo (causation) trong đúng org/request của event gốc. */
const NoteEchoed = defineEvent({
  type: 'fixture.note.echoed',
  version: 1,
  audit: false,
  webhook: false,
  schema: z.object({ body: z.string() }),
});
const chained: { body: string; eventId: string }[] = [];
const echoes: {
  body: string;
  correlationId: string;
  causationId: string | null;
  orgId: string | null;
  ctxOrg?: string;
  sessionOrg: string;
}[] = [];
@Injectable()
@EventSubscriber({ consumer: 'fixture.chain', event: NoteCreated })
class ChainSubscriber {
  constructor(private readonly events: EventPublisher) {}
  async handle(e: EventEnvelope<{ body: string }>) {
    if (!e.data.body.startsWith('chain-')) return;
    chained.push({ body: e.data.body, eventId: e.id });
    await this.events.publish(NoteEchoed, {
      data: { body: e.data.body },
      aggregate: e.aggregate,
      actor: { type: 'service', id: 'fixture.chain' },
      causationId: e.id,
    });
  }
}
@Injectable()
@EventSubscriber({ consumer: 'fixture.echo', event: NoteEchoed })
class EchoSubscriber {
  constructor(
    private readonly ctx: RequestContext,
    private readonly db: Db,
  ) {}
  async handle(e: EventEnvelope<{ body: string }>) {
    const [row] = await this.db.execute<{ o: string }>(
      `SELECT current_setting('app.org_id', true) AS o`,
    );
    echoes.push({
      body: e.data.body,
      correlationId: e.correlationId,
      causationId: e.causationId,
      orgId: e.orgId,
      ctxOrg: this.ctx.orgId(),
      sessionOrg: row?.o ?? '',
    });
  }
}

@Module({
  providers: [
    AuditSubscriber,
    MailerSubscriber,
    DeferredProbeHandler,
    ChainSubscriber,
    EchoSubscriber,
    // WorkerHost bắt buộc đủ handler cho queue `fixture` được consume (Task 8).
    ...fixtureHandlers(),
  ],
})
class Subs {}
const until = async (pred: () => boolean | Promise<boolean>, ms = 15000) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('events end-to-end', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'events,fixture');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '50');
    vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '20');
    app = await createTestApp(
      [
        DatabaseModule.forRoot({ relay: true }),
        RedisModule,
        HttpModule,
        QueueModule.forRoot({ runWorkers: true }),
        OutboxModule.forRoot({ relay: true }),
        EventsModule.forRoot({ worker: true }),
        FixtureNotesModule,
        Subs,
      ],
      { beforeInit: applyHttpDefaults },
    );
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    received.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const outboxIdOf = async (eventId: string) => {
    const [row] = await app
      .get(RelayDb)
      .execute<{ id: string }>(
        'SELECT id::text AS id FROM outbox_events WHERE event_id = ?',
        [eventId],
      );
    if (!row) throw new Error(`no outbox row for ${eventId}`);
    return row.id;
  };
  const eventsJob = (jobId: string) =>
    app.get(BullmqJobQueue).queue('events').getJob(jobId);
  const jobState = async (jobId: string) =>
    (await eventsJob(jobId))?.getState();
  const processedCount = async (consumer: string, eventId: string) => {
    const [row] = await app
      .get(RelayDb)
      .execute<{ n: string }>(
        'SELECT count(*)::text AS n FROM processed_events WHERE consumer = ? AND event_id = ?',
        [consumer, eventId],
      );
    return Number(row?.n);
  };
  const eventIdOf = (body: string, consumer: string) => {
    const hit = received.find(
      (r) => r.body === body && r.consumer === consumer,
    );
    if (!hit) throw new Error(`no delivery of ${body} to ${consumer}`);
    return hit.eventId;
  };
  /** Chạy trong ngữ cảnh request (và org nếu có) như code thật, không phải ngoài CLS. */
  const inScope = <T>(orgId: string | null, fn: () => Promise<T>) =>
    app
      .get(RequestContext)
      .run({}, () => (orgId ? app.get(OrgScope).run(orgId, fn) : fn()));

  it('committed command fans out to every subscriber exactly once', async () => {
    await request(app.getHttpServer())
      .post('/fixture/notes')
      .send({ body: 'n1' })
      .expect(201);
    await until(() => received.filter((r) => r.body === 'n1').length >= 2);
    await request(app.getHttpServer())
      .post('/fixture/notes')
      .send({ body: 'n1-marker' })
      .expect(201);
    await until(
      () => received.filter((r) => r.body === 'n1-marker').length >= 2,
    );
    expect(
      received
        .filter((r) => r.body === 'n1')
        .map((r) => r.consumer)
        .sort(),
    ).toEqual(['fixture.audit', 'fixture.mailer']);
  });

  it('rolled back command emits nothing', async () => {
    await request(app.getHttpServer())
      .post('/fixture/notes')
      .send({ body: 'n2', fail: true })
      .expect(500);
    await app.get(OutboxRelay).drain();
    await request(app.getHttpServer())
      .post('/fixture/notes')
      .send({ body: 'n2-marker' })
      .expect(201);
    await until(
      () => received.filter((r) => r.body === 'n2-marker').length >= 2,
    );
    expect(received.some((r) => r.body === 'n2')).toBe(false);
  });

  it('deferred job (written while Redis was down) is re-enqueued by dispatch and runs', async () => {
    vi.spyOn(app.get(JobQueue), 'enqueueDynamic').mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );
    await app.get(SafeEnqueue).enqueue(DeferredProbe, { n: 7 });
    await until(() => deferredRuns.includes(7));
  });

  it('one failing subscriber is retried without re-running the other', async () => {
    failOnce.add('n3');
    await request(app.getHttpServer())
      .post('/fixture/notes')
      .send({ body: 'n3' })
      .expect(201);
    await until(() => received.filter((r) => r.body === 'n3').length >= 2);
    expect(
      received.filter((r) => r.body === 'n3' && r.consumer === 'fixture.audit'),
    ).toHaveLength(1);
    expect(
      received.filter(
        (r) => r.body === 'n3' && r.consumer === 'fixture.mailer',
      ),
    ).toHaveLength(1);
  });

  it('re-dispatch and duplicate delivery of the same event are no-ops', async () => {
    await request(app.getHttpServer())
      .post('/fixture/notes')
      .send({ body: 'n4' })
      .expect(201);
    await until(() => received.filter((r) => r.body === 'n4').length >= 2);
    const eventId = eventIdOf('n4', 'fixture.audit');
    const outboxId = await outboxIdOf(eventId);
    const original = await eventsJob(`deliver-fixture.audit-${outboxId}`);
    expect(await original?.getState()).toBe('completed');
    const originalFinishedOn = original?.finishedOn;
    const queue = app.get(JobQueue);
    // Dispatch lại: jobId deliver cố định theo (consumer, outboxId) nên BullMQ bỏ qua.
    const redispatch = await queue.enqueue(
      DispatchEventJob,
      { outboxId },
      { jobId: `redispatch-${outboxId}` },
    );
    // Deliver trùng với jobId khác (job cũ đã bị xoá khỏi Redis): Inbox chặn.
    const dup = await queue.enqueue(
      DeliverEventJob,
      { consumer: 'fixture.audit', outboxId },
      { jobId: `dup-${outboxId}` },
    );
    await until(
      async () =>
        (await jobState(redispatch)) === 'completed' &&
        (await jobState(dup)) === 'completed',
    );
    await request(app.getHttpServer())
      .post('/fixture/notes')
      .send({ body: 'n4-marker' })
      .expect(201);
    await until(
      () => received.filter((r) => r.body === 'n4-marker').length >= 2,
    );
    expect(
      received
        .filter((r) => r.body === 'n4')
        .map((r) => r.consumer)
        .sort(),
    ).toEqual(['fixture.audit', 'fixture.mailer']);
    // Dispatch lại không tạo lại job deliver (BullMQ dedupe theo jobId): job cũ không chạy lại.
    const after = await eventsJob(`deliver-fixture.audit-${outboxId}`);
    expect(after?.finishedOn).toBe(originalFinishedOn);
    expect(after?.attemptsMade).toBe(original?.attemptsMade);
    // Job `dup-*` đã chạy nhưng Inbox chặn: đúng một bản ghi đã xử lý.
    expect(await processedCount('fixture.audit', eventId)).toBe(1);
  });

  it('invalid event payload fails delivery without retry and never reaches subscribers', async () => {
    const eventId = v7();
    await app.get(UnitOfWork).run(() =>
      app.get(OutboxWriter).append({
        eventId,
        type: NoteCreated.type,
        version: NoteCreated.version,
        orgId: null,
        aggregate: { type: 'note', id: 'bad', version: 1 },
        payload: { body: 1 },
        headers: { actorType: 'system', actorId: 'test', correlationId: v7() },
      }),
    );
    const outboxId = await outboxIdOf(eventId);
    const jobIds = ['fixture.audit', 'fixture.mailer', 'fixture.chain'].map(
      (c) => `deliver-${c}-${outboxId}`,
    );
    await until(async () =>
      (await Promise.all(jobIds.map(jobState))).every((s) => s === 'failed'),
    );
    for (const jobId of jobIds) {
      const job = await eventsJob(jobId);
      expect(job?.failedReason).toMatch(
        /Invalid payload for job "core\.event\.deliver"/,
      );
      expect(job?.attemptsMade).toBe(1);
    }
    expect(received.some((r) => r.eventId === eventId)).toBe(false);
  });

  it('dispatch of an event type@version unknown to this worker is retried, not silently completed', async () => {
    const eventId = v7();
    await app.get(UnitOfWork).run(() =>
      app.get(OutboxWriter).append({
        eventId,
        type: 'fixture.note.unknown',
        version: 1,
        orgId: null,
        aggregate: { type: 'note', id: 'unknown', version: 1 },
        payload: {},
        headers: { actorType: 'system', actorId: 'test', correlationId: v7() },
      }),
    );
    const jobId = `outbox-${await outboxIdOf(eventId)}`;
    await until(async () => (await jobState(jobId)) === 'failed');
    const job = await eventsJob(jobId);
    expect(job?.failedReason).toMatch(
      /fixture\.note\.unknown@1 .* is not defined in this worker/,
    );
    expect(job?.attemptsMade).toBeGreaterThan(1);
  });

  it('publish rejects an invalid envelope inside the caller transaction and writes nothing', async () => {
    const bad = [
      { actor: { type: 'user', id: '' }, aggregateVersion: 1 },
      { actor: { type: 'user', id: 'u1' }, aggregateVersion: -1 },
    ] as const;
    for (const b of bad) {
      const aggregateId = `i3-${v7()}`;
      const err = await app.get(UnitOfWork).run(() =>
        app
          .get(EventPublisher)
          .publish(NoteCreated, {
            data: { body: 'x' },
            aggregate: {
              type: 'note',
              id: aggregateId,
              version: b.aggregateVersion,
            },
            actor: b.actor,
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          ),
      );
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toMatch(/Invalid event "fixture\.note\.created@1"/);
      const rows = await app
        .get(RelayDb)
        .execute('SELECT 1 FROM outbox_events WHERE aggregate_id = ?', [
          aggregateId,
        ]);
      expect(rows).toHaveLength(0);
    }
  });

  it('deliver job whose org differs from the event org is rejected before the inbox; the correct delivery still runs', async () => {
    const relay = app.get(OutboxRelay);
    const orgA = v7();
    const orgB = v7();
    const publish = (body: string, org: string | null) =>
      inScope(org, () =>
        app.get(UnitOfWork).run(() =>
          app.get(EventPublisher).publish(NoteCreated, {
            data: { body },
            aggregate: { type: 'note', id: body, version: 1 },
            actor: { type: 'system', id: 'test' },
          }),
        ),
      );
    // Dừng relay để lần giao đúng chỉ xảy ra sau khi các job giả đã bị từ chối.
    await relay.stop();
    let forged: { jobId: string; eventId: string }[] = [];
    try {
      const eventA = await publish('org-a-1', orgA);
      const eventNull = await publish('org-null-1', null);
      const outboxA = await outboxIdOf(eventA);
      const outboxNull = await outboxIdOf(eventNull);
      const forge = (org: string | null, outboxId: string, eventId: string) =>
        inScope(org, async () => ({
          eventId,
          jobId: await app
            .get(JobQueue)
            .enqueue(
              DeliverEventJob,
              { consumer: 'fixture.audit', outboxId },
              { jobId: `forged-${v7()}` },
            ),
        }));
      forged = [
        await forge(orgB, outboxA, eventA), // org khác
        await forge(null, outboxA, eventA), // không org cho event có org
        await forge(orgB, outboxNull, eventNull), // có org cho event không org
      ];
      await until(async () =>
        (await Promise.all(forged.map((f) => jobState(f.jobId)))).every(
          (s) => s === 'failed',
        ),
      );
      for (const f of forged) {
        const job = await eventsJob(f.jobId);
        expect(job?.attemptsMade).toBe(1);
        expect(job?.failedReason).toMatch(/does not match outbox row/);
        expect(await processedCount('fixture.audit', f.eventId)).toBe(0);
      }
      expect(
        received.some((r) => r.body === 'org-a-1' || r.body === 'org-null-1'),
      ).toBe(false);
    } finally {
      relay.start();
    }
    await until(
      () =>
        received.filter((r) => r.body === 'org-a-1' || r.body === 'org-null-1')
          .length >= 4,
    );
    for (const f of forged)
      expect(await processedCount('fixture.audit', f.eventId)).toBe(1);
  });

  it('subscriber-published event carries correlation, causation and the org of the source event', async () => {
    const requestId = v7();
    const org = v7().toUpperCase();
    const sourceId = await app.get(RequestContext).run({ requestId }, () =>
      app.get(OrgScope).run(org, () =>
        app.get(UnitOfWork).run(() =>
          app.get(EventPublisher).publish(NoteCreated, {
            data: { body: 'chain-1' },
            aggregate: { type: 'note', id: 'c1', version: 1 },
            actor: { type: 'user', id: 'u1' },
          }),
        ),
      ),
    );
    await until(() => echoes.some((e) => e.body === 'chain-1'));
    expect(chained.find((c) => c.body === 'chain-1')?.eventId).toBe(sourceId);
    expect(echoes.find((e) => e.body === 'chain-1')).toEqual({
      body: 'chain-1',
      correlationId: requestId,
      causationId: sourceId,
      orgId: org.toLowerCase(),
      ctxOrg: org.toLowerCase(),
      sessionOrg: org.toLowerCase(),
    });
  });
});
