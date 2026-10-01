import {
  Global,
  Injectable,
  Logger,
  Module,
  type INestApplication,
} from '@nestjs/common';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { RequestContext } from '../../../../src/core/context/index.js';
import {
  DatabaseModule,
  OrgScope,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  EventPublisher,
  EventSubscriber,
  EventsModule,
  defineEvent,
  type EventEnvelope,
} from '../../../../src/core/events/index.js';
import { OutboxModule } from '../../../../src/core/outbox/index.js';
import {
  JobHandler,
  JobQueue,
  OrgActivityGate,
  QueueModule,
  defineJob,
  defineQueue,
  type JobContext,
  type OrgActivity,
} from '../../../../src/core/queue/index.js';
import { BullmqJobQueue } from '../../../../src/core/queue/bullmq-job-queue.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

/** Before any app exists: the metrics API has no proxy, a counter binds to the provider set at creation. */
const otel = installOtelCapture();
const SKIPPED_METRIC = 'queue_jobs_skipped_total';

const GateQueue = defineQueue('gate-fixture', { kind: 'io' });
const SkipJob = defineJob({
  name: 'gate.skip',
  queue: GateQueue,
  version: 1,
  schema: z.object({ k: z.string() }),
});
const RunJob = defineJob({
  name: 'gate.run',
  queue: GateQueue,
  version: 1,
  schema: z.object({ k: z.string() }),
  onInactiveOrg: 'run',
});
const handled: string[] = [];
/** Trạng thái org của gate giả (không DB) và org của OrgScope mỗi lần gate chạy. */
const state = new Map<string, OrgActivity>();
const calls: (string | undefined)[] = [];
/** Org mà gate giả ném lỗi hạ tầng (fail-closed: job phải lỗi, không bao giờ `completed`). */
const broken = new Set<string>();

@Injectable()
@JobHandler(SkipJob)
class SkipHandler {
  async handle(c: JobContext<{ k: string }>) {
    handled.push(c.payload.k);
  }
}
@Injectable()
@JobHandler(RunJob)
class RunHandler {
  async handle(c: JobContext<{ k: string }>) {
    handled.push(c.payload.k);
  }
}
@Injectable()
class FakeGate extends OrgActivityGate {
  constructor(private readonly ctx: RequestContext) {
    super();
  }
  async check(): Promise<OrgActivity> {
    const org = this.ctx.orgId();
    calls.push(org);
    if (org && broken.has(org)) throw new Error('gate down');
    return (org ? state.get(org) : undefined) ?? { kind: 'ACTIVE' };
  }
}
/**
 * `@Global()`: `WorkerHost` nằm trong `QueueModule` (global) và resolve `@Optional()` theo phạm vi module của nó, nên
 * provider gate phải global — cùng lý do tenancy cài gate trong một module `@Global()` (spec §5.2, INT3-5b).
 */
@Global()
@Module({
  providers: [FakeGate, { provide: OrgActivityGate, useExisting: FakeGate }],
  exports: [OrgActivityGate],
})
class GateModule {}
@Module({ providers: [SkipHandler, RunHandler] })
class Handlers {}

/** Event của org đã mất (ví dụ `tenancy.org.purged`) vẫn phải qua `core.event.dispatch` → `core.event.deliver` tới subscriber. */
const OrgGoneProbe = defineEvent({
  type: 'fixture.gate.org_gone',
  version: 1,
  audit: false,
  webhook: false,
  schema: z.object({ k: z.string() }),
});
const delivered: { k: string; orgId: string | null; ctxOrg?: string }[] = [];
@Injectable()
@EventSubscriber({ consumer: 'fixture.gate.probe', event: OrgGoneProbe })
class OrgGoneSubscriber {
  constructor(private readonly ctx: RequestContext) {}
  async handle(e: EventEnvelope<{ k: string }>) {
    delivered.push({ k: e.data.k, orgId: e.orgId, ctxOrg: this.ctx.orgId() });
  }
}
@Module({ providers: [OrgGoneSubscriber] })
class EventSubs {}

type SkipLog = { event: string; jobId: string };
const isSkipLog = (v: unknown): v is SkipLog =>
  typeof v === 'object' &&
  v !== null &&
  'event' in v &&
  'jobId' in v &&
  typeof v.event === 'string' &&
  v.event.startsWith('job_skipped') &&
  typeof v.jobId === 'string';
const until = async (pred: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const base = () => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: true }),
  Handlers,
];

describe('WorkerHost org activity gate (spec SP3 §5.2, §5.3)', () => {
  afterEach(() => {
    handled.length = 0;
    calls.length = 0;
    state.clear();
    broken.clear();
    delivered.length = 0;
    vi.restoreAllMocks();
  });

  describe('with a gate', () => {
    let app: INestApplication;
    beforeAll(async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'gate-fixture');
      // Một lần thử: job gate ném lỗi tới `failed` ngay, không chờ backoff (không test nào khác ở đây dựa vào retry).
      vi.stubEnv('QUEUE_DEFAULT_ATTEMPTS', '1');
      app = await createTestApp([...base(), GateModule]);
    });
    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });

    it('an active org runs the handler, and the gate ran inside the OrgScope of the job', async () => {
      const org = v7();
      await app
        .get(JobQueue)
        .enqueue(SkipJob, { k: 'active' }, { meta: { orgId: org } });
      await until(() => handled.includes('active'));
      expect(calls).toEqual([org]);
    });
    it('DELETED before enqueue → INFO; enqueued after deletedAt or GONE → WARN; handler never runs', async () => {
      const log = vi.spyOn(Logger.prototype, 'log');
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const [before, after, gone] = [v7(), v7(), v7()];
      state.set(before, {
        kind: 'DELETED',
        deletedAt: new Date(Date.now() + 60_000),
      });
      state.set(after, {
        kind: 'DELETED',
        deletedAt: new Date(Date.now() - 60_000),
      });
      state.set(gone, { kind: 'GONE' });
      const skippedBefore =
        (await otel.metric(SKIPPED_METRIC, { reason: 'org_inactive' })) ?? 0;
      const q = app.get(JobQueue);
      const ids = [
        await q.enqueue(SkipJob, { k: 'before' }, { meta: { orgId: before } }),
        await q.enqueue(SkipJob, { k: 'after' }, { meta: { orgId: after } }),
        await q.enqueue(SkipJob, { k: 'gone' }, { meta: { orgId: gone } }),
      ];
      const skipped = () =>
        [...log.mock.calls, ...warn.mock.calls]
          .map((c) => c[0])
          .filter(isSkipLog);
      await until(() => skipped().length >= 3);
      expect(handled).toEqual([]);
      const byId = new Map(skipped().map((s) => [s.jobId, s.event]));
      expect(ids.map((id) => byId.get(id))).toEqual([
        'job_skipped_org_inactive',
        'job_skipped_org_inactive_after_delete',
        'job_skipped_org_inactive_after_delete',
      ]);
      // Mỗi job bỏ qua đếm một lần; label chỉ là lý do (không queue/org/job).
      expect(
        await otel.metric(SKIPPED_METRIC, { reason: 'org_inactive' }),
      ).toBe(skippedBefore + 3);
      expect(
        (await otel.dataPoints(SKIPPED_METRIC)).map((d) => d.attributes),
      ).toEqual([{ reason: 'org_inactive' }]);
    });
    it('a gate that throws fails the job (fail-closed): never completed, handler not run, nothing logged or counted as skipped', async () => {
      const log = vi.spyOn(Logger.prototype, 'log');
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const org = v7();
      broken.add(org);
      const skippedBefore =
        (await otel.metric(SKIPPED_METRIC, { reason: 'org_inactive' })) ?? 0;
      const id = await app
        .get(JobQueue)
        .enqueue(SkipJob, { k: 'gate-down' }, { meta: { orgId: org } });
      const job = () =>
        app.get(BullmqJobQueue).queue(GateQueue.name).getJob(id);
      const finalState = async () => {
        const s = await (await job())?.getState();
        return s === 'failed' || s === 'completed' ? s : undefined;
      };
      await until(async () => (await finalState()) !== undefined);
      expect(await finalState()).toBe('failed');
      expect((await job())?.failedReason).toBe('gate down');
      expect(calls).toEqual([org]);
      expect(handled).toEqual([]);
      expect(
        [...log.mock.calls, ...warn.mock.calls]
          .map((c) => c[0])
          .filter(isSkipLog),
      ).toEqual([]);
      expect(
        (await otel.metric(SKIPPED_METRIC, { reason: 'org_inactive' })) ?? 0,
      ).toBe(skippedBefore);
    });
    it("onInactiveOrg: 'run' runs even when the org is gone; a job without orgId never asks the gate", async () => {
      const org = v7();
      state.set(org, { kind: 'GONE' });
      await app
        .get(JobQueue)
        .enqueue(RunJob, { k: 'run-gone' }, { meta: { orgId: org } });
      await app.get(JobQueue).enqueue(SkipJob, { k: 'no-org' });
      await until(
        () => handled.includes('run-gone') && handled.includes('no-org'),
      );
      expect(calls).toEqual([]);
    });
  });

  describe('without a gate provider', () => {
    let app: INestApplication;
    beforeAll(async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'gate-fixture');
      app = await createTestApp(base());
    });
    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });
    it('behaves as before: the handler runs', async () => {
      await app
        .get(JobQueue)
        .enqueue(SkipJob, { k: 'legacy' }, { meta: { orgId: v7() } });
      await until(() => handled.includes('legacy'));
    });
  });

  describe('event relay through a gone org (spec r3: org lifecycle events are never lost)', () => {
    let app: INestApplication;
    beforeAll(async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'events');
      vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '50');
      app = await createTestApp([
        DatabaseModule.forRoot({ relay: true }),
        RedisModule,
        QueueModule.forRoot({ runWorkers: true }),
        OutboxModule.forRoot({ relay: true }),
        EventsModule.forRoot({ worker: true }),
        GateModule,
        EventSubs,
      ]);
    });
    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });
    it('core.event.dispatch and core.event.deliver run for a GONE org and reach the subscriber in that org', async () => {
      const org = v7();
      state.set(org, { kind: 'GONE' });
      await app.get(RequestContext).run({}, () =>
        app.get(OrgScope).run(org, () =>
          app.get(UnitOfWork).run(() =>
            app.get(EventPublisher).publish(OrgGoneProbe, {
              data: { k: 'purged' },
              aggregate: { type: 'org', id: org, version: 1 },
              actor: { type: 'service', id: 'fixture.gate' },
            }),
          ),
        ),
      );
      await until(() => delivered.some((d) => d.k === 'purged'));
      expect(delivered).toEqual([{ k: 'purged', orgId: org, ctxOrg: org }]);
      expect(calls).toEqual([]);
    });
  });
});
