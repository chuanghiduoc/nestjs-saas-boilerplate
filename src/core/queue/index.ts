export { QueueModule } from './queue.module.js';
export { JobQueue, type EnqueueOpts, type EnqueueItem } from './job-queue.js';
export { JobScheduler, type SchedulePattern } from './bullmq-job-scheduler.js';
export { WorkerHost } from './worker-host.js';
export { JobHandler } from './job-handler.decorator.js';
export {
  defineQueue,
  defineJob,
  assertEnqueueOpts,
  encodeJobData,
  decodeJobData,
  JobPayloadError,
  queueRegistry,
  jobRegistry,
  findJob,
  type JobDef,
  type QueueDef,
  type JobMeta,
} from './job-definition.js';
export type { JobContext } from './job-context.js';
export { MaintenanceQueue } from './core-queues.js';
export { queueConfig } from './queue.config.js';
