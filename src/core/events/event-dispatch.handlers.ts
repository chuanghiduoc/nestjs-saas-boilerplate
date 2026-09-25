import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';
import { RelayDb, UnitOfWork } from '../database/index.js';
import {
  DEFERRED_JOB_EVENT_TYPE,
  DeferredJobPayload,
  DispatchEventJob,
  EventsQueue,
  Inbox,
} from '../outbox/index.js';
import {
  JobHandler,
  JobPayloadError,
  JobQueue,
  defineJob,
  findJob,
  type JobContext,
  type JobDef,
  type JobMeta,
} from '../queue/index.js';
import { eventKey, findEvent, type EventDef } from './event-definition.js';
import { parseEnvelope, type EventEnvelope } from './envelope.js';
import {
  EventSubscriberMarker,
  isEventHandlerInstance,
  type EventHandlerInstance,
  type SubscriberMeta,
} from './subscriber.decorator.js';

/** Mỗi (subscriber, dòng outbox) một job: subscriber lỗi chỉ retry chính nó. */
export const DeliverEventJob = defineJob({
  name: 'core.event.deliver',
  queue: EventsQueue,
  version: 1,
  schema: z.object({ consumer: z.string(), outboxId: z.string() }),
});

/** Consumer nằm trong jobId deliver: BullMQ cấm `:`; cùng luật với tên job/queue. */
const CONSUMER_PATTERN = /^[a-z][a-z0-9._-]*$/;
/** outboxId là BIGINT (chỉ chữ số) nên jobId là duy nhất theo (consumer, outboxId) và không chứa `:`. */
const deliverJobId = (consumer: string, outboxId: string) =>
  `deliver-${consumer}-${outboxId}`;

type Entry = { meta: SubscriberMeta; instance: EventHandlerInstance };

/** Nạp trong `onModuleInit` (trước mọi `onApplicationBootstrap`), nên đã đầy đủ khi WorkerHost bắt đầu nhận job. */
@Injectable()
export class SubscriberRegistry implements OnModuleInit {
  private readonly consumers = new Map<string, Entry>();
  private readonly events = new Map<string, Entry[]>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: EventSubscriberMarker.KEY,
    })) {
      const meta = this.discovery.getMetadataByDecorator(
        EventSubscriberMarker,
        wrapper,
      );
      if (!meta) continue;
      if (!CONSUMER_PATTERN.test(meta.consumer))
        throw new Error(
          `@EventSubscriber consumer "${meta.consumer}" must match ${CONSUMER_PATTERN}`,
        );
      if (
        !wrapper.isDependencyTreeStatic() ||
        !isEventHandlerInstance(wrapper.instance)
      )
        throw new Error(
          `@EventSubscriber(${meta.consumer}) class must be a singleton provider implementing handle(e)`,
        );
      const key = eventKey(meta.event.type, meta.event.version);
      if (findEvent(meta.event.type, meta.event.version) !== meta.event)
        throw new Error(
          `@EventSubscriber(${meta.consumer}) event ${key} was not created by defineEvent`,
        );
      if (this.consumers.has(meta.consumer))
        throw new Error(`Duplicate subscriber consumer "${meta.consumer}"`);
      const entry: Entry = { meta, instance: wrapper.instance };
      this.consumers.set(meta.consumer, entry);
      this.events.set(key, [...(this.events.get(key) ?? []), entry]);
    }
  }

  byConsumer(consumer: string): Entry | undefined {
    return this.consumers.get(consumer);
  }

  forEvent(type: string, version: number): Entry[] {
    return this.events.get(eventKey(type, version)) ?? [];
  }
}

const OutboxRow = z.object({
  id: z.string(),
  event_id: z.string(),
  type: z.string(),
  version: z.int(),
  org_id: z.string().nullable(),
  aggregate_type: z.string(),
  aggregate_id: z.string(),
  aggregate_version: z.string(),
  payload: z.unknown(),
  headers: z.record(z.string(), z.string()),
  occurred_at: z.coerce.date(),
});
export type OutboxRow = z.infer<typeof OutboxRow>;

/** `app_user` không SELECT được outbox: handler đọc bằng `RelayDb` (role `app_relay`, chỉ có trong worker). */
@Injectable()
export class OutboxReader {
  constructor(private readonly relayDb: RelayDb) {}

  /** Không thấy dòng: lỗi thường (retry). Dòng sai hình dạng: `JobPayloadError` của `job` (không retry). */
  async load(job: JobDef, outboxId: string): Promise<OutboxRow> {
    const rows = await this.relayDb.execute(
      `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id,
              aggregate_type, aggregate_id, aggregate_version::text AS aggregate_version,
              payload, headers, occurred_at
       FROM outbox_events WHERE id = ?::bigint`,
      [outboxId],
    );
    if (!rows[0]) throw new Error(`Outbox row ${outboxId} not found`);
    const row = OutboxRow.safeParse(rows[0]);
    if (!row.success)
      throw new JobPayloadError(
        job.name,
        `outbox row ${outboxId}: ${z.prettifyError(row.error)}`,
      );
    return row.data;
  }
}

/** Dựng envelope thô từ dòng outbox, không điền giá trị thay thế: thiếu gì thì `parseEnvelope` từ chối. */
export function toEnvelope(row: OutboxRow): unknown {
  return {
    id: row.event_id,
    type: row.type,
    version: row.version,
    occurredAt: row.occurred_at.toISOString(),
    orgId: row.org_id,
    actor: { type: row.headers.actorType, id: row.headers.actorId },
    aggregate: {
      type: row.aggregate_type,
      id: row.aggregate_id,
      version: Number(row.aggregate_version),
    },
    correlationId: row.headers.correlationId,
    causationId: row.headers.causationId ?? null,
    traceparent: row.headers.traceparent,
    data: row.payload,
  };
}

/** Job con chạy trong ngữ cảnh của request gốc (correlation/trace) và OrgScope của event. */
const metaOf = (row: OutboxRow): JobMeta => ({
  orgId: row.org_id ?? undefined,
  traceparent: row.headers.traceparent,
  requestId: row.headers.correlationId,
});

/**
 * Relay → dispatch → deliver. Dòng `core.job.deferred` (SafeEnqueue) được enqueue thành job
 * thật với đúng `jobId` (BullMQ bỏ qua nếu job đó đã có) và meta gốc; `delayMs` tính từ lúc
 * dispatch. Event thường: mỗi subscriber một job deliver, jobId cố định theo (consumer, outboxId)
 * nên dispatch lại (retry, relay gửi lại) không tạo job trùng khi job cũ còn trong Redis; chốt
 * chống trùng cuối cùng là Inbox. Job/subscriber chưa đăng ký là lỗi cấu hình (deploy lệch
 * version): lỗi thường, retry rồi vào tập failed.
 */
@Injectable()
@JobHandler(DispatchEventJob)
export class DispatchEventHandler {
  constructor(
    private readonly reader: OutboxReader,
    private readonly subs: SubscriberRegistry,
    private readonly queue: JobQueue,
  ) {}

  async handle(ctx: JobContext<{ outboxId: string }>): Promise<void> {
    const row = await this.reader.load(DispatchEventJob, ctx.payload.outboxId);
    const meta = metaOf(row);
    if (row.type === DEFERRED_JOB_EVENT_TYPE) {
      const d = DeferredJobPayload.safeParse(row.payload);
      if (!d.success)
        throw new JobPayloadError(
          DispatchEventJob.name,
          `deferred job in outbox row ${row.id}: ${z.prettifyError(d.error)}`,
        );
      const job = findJob(d.data.job);
      if (!job)
        throw new Error(`Deferred job "${d.data.job}" is not registered`);
      await this.queue.enqueueDynamic(job, d.data.payload, {
        jobId: d.data.jobId,
        delayMs: d.data.delayMs,
        meta,
      });
      return;
    }
    const targets = this.subs.forEvent(row.type, row.version);
    if (targets.length === 0) {
      ctx.log.debug(
        { outboxId: row.id, type: row.type },
        'event has no subscribers',
      );
      return;
    }
    await this.queue.enqueueMany(
      targets.map((t) => ({
        job: DeliverEventJob,
        payload: { consumer: t.meta.consumer, outboxId: row.id },
        opts: { jobId: deliverJobId(t.meta.consumer, row.id), meta },
      })),
    );
  }
}

/**
 * Chạy một subscriber cho một event: parse theo schema của đúng `type@version`, rồi
 * `UnitOfWork` + `Inbox.once` (cùng transaction với side effect DB của subscriber). Giao trùng
 * là no-op. Payload/envelope sai là `JobPayloadError` (không retry: dữ liệu không tự lành).
 * WorkerHost đã đặt OrgScope theo `meta.orgId` = org của event.
 */
@Injectable()
@JobHandler(DeliverEventJob)
export class DeliverEventHandler {
  constructor(
    private readonly reader: OutboxReader,
    private readonly subs: SubscriberRegistry,
    private readonly inbox: Inbox,
    private readonly uow: UnitOfWork,
  ) {}

  async handle(
    ctx: JobContext<{ consumer: string; outboxId: string }>,
  ): Promise<void> {
    const { consumer, outboxId } = ctx.payload;
    const sub = this.subs.byConsumer(consumer);
    if (!sub)
      throw new Error(
        `Subscriber "${consumer}" is not registered in this worker`,
      );
    const row = await this.reader.load(DeliverEventJob, outboxId);
    const def = sub.meta.event;
    if (eventKey(row.type, row.version) !== eventKey(def.type, def.version))
      throw new Error(
        `Subscriber "${consumer}" handles ${eventKey(def.type, def.version)} in this worker, but outbox row ${outboxId} is ${eventKey(row.type, row.version)}`,
      );
    const envelope = this.parse(def, row);
    ctx.signal.throwIfAborted();
    const result = await this.uow.run(() =>
      this.inbox.once(consumer, envelope.id, () =>
        sub.instance.handle(envelope),
      ),
    );
    if (result === 'duplicate')
      ctx.log.debug(
        { consumer, eventId: envelope.id },
        'duplicate delivery skipped',
      );
  }

  private parse(def: EventDef, row: OutboxRow): EventEnvelope<unknown> {
    try {
      return parseEnvelope(def, toEnvelope(row));
    } catch (err) {
      if (err instanceof z.ZodError)
        throw new JobPayloadError(
          DeliverEventJob.name,
          `event ${eventKey(row.type, row.version)} in outbox row ${row.id}: ${z.prettifyError(err)}`,
        );
      throw err;
    }
  }
}
