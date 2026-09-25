import { z } from 'zod';
import { defineJob, defineQueue } from '../queue/index.js';

export const EventsQueue = defineQueue('events', { kind: 'io' });
/** Relay đẩy một job cho mỗi dòng outbox; handler (Task 10) đọc dòng theo `outboxId` bằng `RelayDb`. */
export const DispatchEventJob = defineJob({
  name: 'core.event.dispatch',
  queue: EventsQueue,
  version: 1,
  schema: z.object({ outboxId: z.string() }),
});
/** Loại event outbox của `SafeEnqueue`: job được enqueue sau commit, với đúng `jobId` đã sinh. */
export const DEFERRED_JOB_EVENT_TYPE = 'core.job.deferred';
export const DeferredJobPayload = z.object({
  job: z.string(),
  payload: z.unknown(),
  jobId: z.string(),
  delayMs: z.number().optional(),
});
