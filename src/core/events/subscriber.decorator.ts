import { DiscoveryService } from '@nestjs/core';
import type { z } from 'zod';
import type { EventDef } from './event-definition.js';
import type { EventEnvelope } from './envelope.js';

/** Tập event một subscriber nhận thay vì một `type@version` (spec SP6 §5.3): audit (6B) và webhook (6C). */
export type EventSelector = {
  readonly name: 'audit' | 'webhook';
  matches(def: EventDef): boolean;
};
export const AUDITED_EVENTS: EventSelector = {
  name: 'audit',
  matches: (def) => def.audit,
};
export const WEBHOOK_EVENTS: EventSelector = {
  name: 'webhook',
  matches: (def) => def.webhook,
};
/** Chỉ hai bộ chọn này hợp lệ: bộ chọn tự chế sẽ lặng lẽ nhận event ngoài hợp đồng của cờ. */
export const EVENT_SELECTORS: readonly EventSelector[] = [
  AUDITED_EVENTS,
  WEBHOOK_EVENTS,
];

/**
 * `consumer` là định danh bền của subscriber: khoá Inbox (`processed_events.consumer`) và một phần
 * jobId deliver. Đổi tên nghĩa là mọi event cũ được coi là chưa xử lý với consumer mới.
 * `event`: đúng một `type@version`; `events`: mọi def khớp bộ chọn (handler nhận `EventEnvelope<unknown>`).
 */
export type SubscriberMeta =
  | { consumer: string; event: EventDef }
  | { consumer: string; events: EventSelector };

/** Decorator có kiểu của Nest Discovery (giống `@JobHandler`): đọc lại meta không cần cast. */
export const EventSubscriberMarker =
  DiscoveryService.createDecorator<SubscriberMeta>();

export const EventSubscriber = (meta: SubscriberMeta): ClassDecorator =>
  EventSubscriberMarker(meta);

/**
 * `handle` chạy trong `UnitOfWork` + `Inbox.once` (cùng transaction) và có thể chạy lại (retry,
 * transaction retry 40001/40P01). Trong `handle` CHỈ làm việc với DB: không gọi HTTP/Redis/SMTP
 * hay I/O ngoài nào khác (ADR 0006, "No external I/O inside a DB transaction"). Gọi chậm quá
 * `idle_in_transaction_session_timeout` thì Postgres giết session và connection bị rò khỏi pool.
 * Side effect ngoài DB: trong `handle`, gọi `SafeEnqueue.enqueue` một job (được ghi outbox, commit
 * cùng bản ghi Inbox); job handler đó chạy ngoài transaction, gọi `HttpClient` và phải idempotent
 * (dùng `e.id` làm idempotency key phía provider).
 */
export interface EventHandlerInstance {
  handle(e: EventEnvelope<unknown>): Promise<void>;
}

/**
 * Kiểu cho class subscriber (`implements EventHandler<typeof MyEvent>`): buộc `handle` nhận đúng
 * `data` theo schema của event, vì decorator không ràng buộc được kiểu của method.
 */
export interface EventHandler<D extends EventDef> {
  // Kiểu property (không phải method) để strictFunctionTypes kiểm tham số chặt, không bivariant.
  handle: (e: EventEnvelope<z.infer<D['schema']>>) => Promise<void>;
}

export const isEventHandlerInstance = (v: unknown): v is EventHandlerInstance =>
  typeof v === 'object' &&
  v !== null &&
  'handle' in v &&
  typeof v.handle === 'function';
