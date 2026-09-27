import {
  type DynamicModule,
  type Provider,
  Global,
  Module,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { QueueMetrics } from '../observability/queue-metrics.js';
import { BullmqJobQueue } from './bullmq-job-queue.js';
import { BullmqJobScheduler, JobScheduler } from './bullmq-job-scheduler.js';
import { QueueDashboardServer } from './dashboard/queue-dashboard.server.js';
import { JobQueue } from './job-queue.js';
import {
  WORKER_HOST_OPTIONS,
  WorkerHost,
  type WorkerHostOptions,
} from './worker-host.js';

/** BullMQ trực tiếp, không `@nestjs/bullmq` (ADR 0006): Worker tạo lúc chạy theo `WORKER_QUEUES`. */
@Global()
@Module({})
export class QueueModule {
  static forRoot(opts: WorkerHostOptions): DynamicModule {
    const providers: Provider[] = [
      BullmqJobQueue,
      { provide: JobQueue, useExisting: BullmqJobQueue },
      BullmqJobScheduler,
      { provide: JobScheduler, useExisting: BullmqJobScheduler },
      { provide: WORKER_HOST_OPTIONS, useValue: opts },
      QueueMetrics,
      WorkerHost,
      // Bull Board đọc mọi queue trong Redis: chỉ đúng một deployment (worker) bật
      // QUEUE_DASHBOARD_ENABLED, nên chỉ tạo provider này khi `runWorkers` (spec §5.12).
      ...(opts.runWorkers ? [QueueDashboardServer] : []),
    ];
    return {
      module: QueueModule,
      imports: [DiscoveryModule],
      providers,
      exports: [JobQueue, BullmqJobQueue, JobScheduler, WorkerHost],
    };
  }
}
