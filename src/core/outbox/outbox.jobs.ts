import { z } from 'zod';
import { MaintenanceQueue, defineJob, defineQueue } from '../queue/index.js';
import { defineCron } from '../scheduler/cron-definition.js';
import { outboxConfig } from './outbox.config.js';

export const EventsQueue = defineQueue('events', { kind: 'io' });
/** Relay đẩy một job cho mỗi dòng outbox; handler (Task 10) đọc dòng theo `outboxId` bằng `RelayDb`. */
export const DispatchEventJob = defineJob({
  name: 'core.event.dispatch',
  queue: EventsQueue,
  version: 1,
  schema: z.object({ outboxId: z.string() }),
  // Chỉ chuyển tiếp (spec SP3 §5.2, INT3-1): bị bỏ qua thì event của org vừa xoá mềm/purge mất vĩnh viễn; job con tự chịu gate của mình.
  onInactiveOrg: 'run',
});
/** Loại event outbox của `SafeEnqueue`: job được enqueue sau commit, với đúng `jobId` đã sinh. */
export const DEFERRED_JOB_EVENT_TYPE = 'core.job.deferred';
export const DeferredJobPayload = z.object({
  job: z.string(),
  payload: z.unknown(),
  jobId: z.string(),
  delayMs: z.number().optional(),
});
/** Xoá theo lô dòng outbox đã publish và bản ghi inbox quá hạn giữ (`OutboxCleanupHandler`). */
export const OutboxCleanupJob = defineJob({
  name: 'core.outbox.cleanup',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
defineCron({
  key: 'core.outbox.cleanup',
  job: OutboxCleanupJob,
  payload: {},
  schedule: () => {
    const c = outboxConfig();
    return { cron: c.cleanupCron, tz: c.cleanupTz };
  },
});
