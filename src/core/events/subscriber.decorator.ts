import { DiscoveryService } from '@nestjs/core';
import type { EventDef } from './event-definition.js';
import type { EventEnvelope } from './envelope.js';

/**
 * `consumer` là định danh bền của subscriber: khoá Inbox (`processed_events.consumer`) và một phần
 * jobId deliver. Đổi tên nghĩa là mọi event cũ được coi là chưa xử lý với consumer mới.
 */
export type SubscriberMeta = { consumer: string; event: EventDef };

/** Decorator có kiểu của Nest Discovery (giống `@JobHandler`): đọc lại meta không cần cast. */
export const EventSubscriberMarker =
  DiscoveryService.createDecorator<SubscriberMeta>();

export const EventSubscriber = (meta: SubscriberMeta): ClassDecorator =>
  EventSubscriberMarker(meta);

/**
 * `handle` chạy trong `UnitOfWork` + `Inbox.once` (cùng transaction) và có thể chạy lại (retry,
 * transaction retry 40001/40P01), nên side effect ngoài DB phải idempotent (dùng `e.id` làm
 * idempotency key phía provider).
 */
export interface EventHandlerInstance {
  handle(e: EventEnvelope<unknown>): Promise<void>;
}

export const isEventHandlerInstance = (v: unknown): v is EventHandlerInstance =>
  typeof v === 'object' &&
  v !== null &&
  'handle' in v &&
  typeof v.handle === 'function';
