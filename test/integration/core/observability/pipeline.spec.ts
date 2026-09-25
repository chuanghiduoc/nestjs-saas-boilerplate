import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { z } from 'zod';
import { RequestContext } from '../../../../src/core/context/index.js';
import {
  DatabaseModule,
  RelayDb,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  DeliverEventJob,
  EventPublisher,
  EventSubscriber,
  EventsModule,
  defineEvent,
  type EventEnvelope,
} from '../../../../src/core/events/index.js';
import { ObservabilityModule } from '../../../../src/core/observability/index.js';
import {
  DispatchEventJob,
  OutboxModule,
  OutboxRelay,
  outboxConfig,
} from '../../../../src/core/outbox/index.js';
import { JobQueue, QueueModule } from '../../../../src/core/queue/index.js';
import { BullmqJobQueue } from '../../../../src/core/queue/bullmq-job-queue.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { RecordJob } from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

const ThingHappened = defineEvent({
  type: 'test.thing.traced',
  version: 1,
  schema: z.object({ n: z.number() }),
});
const delivered: { n: number; activeTraceId?: string; ctxTraceId?: string }[] =
  [];

@Injectable()
@EventSubscriber({ consumer: 'test.trace-probe', event: ThingHappened })
class TraceProbe {
  constructor(private readonly ctx: RequestContext) {}
  async handle(e: EventEnvelope<{ n: number }>) {
    delivered.push({
      n: e.data.n,
      activeTraceId: trace.getActiveSpan()?.spanContext().traceId,
      ctxTraceId: this.ctx.traceId(),
    });
  }
}
@Module({ providers: [TraceProbe] })
class Probes {}

/** Reader thủ công: test tự gọi `collect()` thay vì chờ chu kỳ export. */
class TestReader extends sdkMetrics.MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

const until = async (pred: () => boolean | Promise<boolean>, ms = 15000) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('observability pipeline', () => {
  const spans = new InMemorySpanExporter();
  const reader = new TestReader();
  const meterProvider = new sdkMetrics.MeterProvider({ readers: [reader] });
  let app: INestApplication;

  /** Giá trị của một datapoint (gauge/counter) theo tên metric và queue; không có thì undefined. */
  const valueOf = async (
    name: string,
    queue?: string,
  ): Promise<number | undefined> => {
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    for (const scope of resourceMetrics.scopeMetrics)
      for (const m of scope.metrics) {
        if (m.descriptor.name !== name) continue;
        if (
          m.dataPointType !== sdkMetrics.DataPointType.GAUGE &&
          m.dataPointType !== sdkMetrics.DataPointType.SUM
        )
          throw new Error(`${name} is not a gauge or sum`);
        const dp = m.dataPoints.find(
          (d) => queue === undefined || d.attributes.queue === queue,
        );
        if (dp) return dp.value;
      }
    return undefined;
  };

  beforeAll(async () => {
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spans)],
    });
    provider.register({
      contextManager: new AsyncLocalStorageContextManager().enable(),
      propagator: new W3CTraceContextPropagator(),
    });
    metrics.setGlobalMeterProvider(meterProvider);
    vi.stubEnv('APP_ROLE', 'worker');
    // `fixture` không được consume: job của nó nằm lại ở trạng thái waiting để đo.
    vi.stubEnv('WORKER_QUEUES', 'events');
    vi.stubEnv('OUTBOX_AUTOSTART', 'false');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }),
      ObservabilityModule.forRoot({ worker: true }),
      Probes,
    ]);
    // DB dùng chung giữa các file test: dòng chưa publish do file khác để lại (cố ý hỏng) được park
    // để không tính vào lag, đúng như dòng bị park thật.
    await app
      .get(RelayDb)
      .execute(
        'UPDATE outbox_events SET publish_attempts = ? WHERE published_at IS NULL',
        [outboxConfig().maxPublishAttempts],
      );
  });
  afterAll(async () => {
    await app?.close();
    await meterProvider.shutdown();
    metrics.disable();
    propagation.disable();
    context.disable();
    trace.disable();
    vi.unstubAllEnvs();
  });

  const publishInSpan = (n: number) =>
    app.get(RequestContext).run({}, () =>
      trace.getTracer('test').startActiveSpan('POST /things', async (span) => {
        try {
          await app.get(UnitOfWork).run(() =>
            app.get(EventPublisher).publish(ThingHappened, {
              data: { n },
              aggregate: { type: 'thing', id: String(n), version: 1 },
              actor: { type: 'system', id: 'test' },
            }),
          );
          return span.spanContext().traceId;
        } finally {
          span.end();
        }
      }),
    );

  it('one trace spans request → outbox → relay → dispatch job → deliver job', async () => {
    const traceId = await publishInSpan(1);
    await app.get(OutboxRelay).drain();
    await until(() => delivered.some((d) => d.n === 1));
    expect(delivered.find((d) => d.n === 1)).toEqual({
      n: 1,
      activeTraceId: traceId,
      ctxTraceId: traceId,
    });
    const jobSpanNames = [
      `job ${DispatchEventJob.name}`,
      `job ${DeliverEventJob.name}`,
    ];
    const jobSpansOf = () =>
      spans.getFinishedSpans().filter((s) => jobSpanNames.includes(s.name));
    // Span deliver kết thúc sau khi subscriber chạy xong.
    await until(() => jobSpansOf().length === 2);
    const jobSpans = jobSpansOf();
    expect(jobSpans.map((s) => s.name).sort()).toEqual(
      [`job ${DeliverEventJob.name}`, `job ${DispatchEventJob.name}`].sort(),
    );
    for (const s of jobSpans) expect(s.spanContext().traceId).toBe(traceId);
  });

  it('reports queue depth, oldest waiting age and outbox lag', async () => {
    await app.get(JobQueue).enqueue(RecordJob, { key: 'waits' });
    await publishInSpan(2);
    const WAIT_MS = 50;
    await new Promise((r) => setTimeout(r, WAIT_MS));
    // Job mới hơn: tuổi phải lấy từ job cũ nhất, không phải job vừa thêm.
    await app.get(JobQueue).enqueue(RecordJob, { key: 'newer' });

    const stats = await app.get(JobQueue).stats();
    const fixture = stats.find((s) => s.queue === RecordJob.queue.name);
    expect(fixture?.waiting).toBe(2);
    expect(fixture?.oldestWaitingAgeMs).toBeGreaterThanOrEqual(WAIT_MS);
    expect(stats.find((s) => s.queue === 'events')).toMatchObject({
      oldestWaitingAgeMs: null,
    });

    expect(await valueOf('queue_depth', RecordJob.queue.name)).toBe(2);
    expect(
      await valueOf('queue_oldest_job_age_seconds', RecordJob.queue.name),
    ).toBeGreaterThanOrEqual(WAIT_MS / 1000);
    expect(await valueOf('outbox_lag_seconds')).toBeGreaterThanOrEqual(
      WAIT_MS / 1000,
    );

    await app.get(OutboxRelay).drain();
    await until(() => delivered.some((d) => d.n === 2));
    expect(await valueOf('outbox_lag_seconds')).toBe(0);
  });

  it('moves parked outbox rows from the lag to the parked gauge (same criterion as the relay)', async () => {
    const max = outboxConfig().maxPublishAttempts;
    const setAttempts = (n: number) =>
      app.get(RelayDb).execute(
        `UPDATE outbox_events SET publish_attempts = ?
           WHERE published_at IS NULL AND type = ? AND aggregate_id = '3'`,
        [n, ThingHappened.type],
      );
    const parkedBefore = await valueOf('outbox_parked_events');
    await publishInSpan(3);
    await new Promise((r) => setTimeout(r, 20));

    // Một lần thử trước ngưỡng: relay vẫn claim dòng này, nên nó là lag, chưa phải parked.
    await setAttempts(max - 1);
    expect(await valueOf('outbox_lag_seconds')).toBeGreaterThan(0);
    expect(await valueOf('outbox_parked_events')).toBe(parkedBefore);

    await setAttempts(max);
    expect(await valueOf('outbox_lag_seconds')).toBe(0);
    expect(await valueOf('outbox_parked_events')).toBe((parkedBefore ?? 0) + 1);
  });

  it('counts failed job attempts per queue', async () => {
    await app
      .get(BullmqJobQueue)
      .queue('events')
      .add(DispatchEventJob.name, { v: 99, p: {}, meta: {} });
    await until(
      async () => (await valueOf('queue_failed_total', 'events')) === 1,
    );
  });
});
