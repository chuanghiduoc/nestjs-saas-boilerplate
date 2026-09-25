import { type DynamicModule, Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullmqJobQueue } from './bullmq-job-queue.js';
import { BullmqJobScheduler, JobScheduler } from './bullmq-job-scheduler.js';
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
    return {
      module: QueueModule,
      imports: [DiscoveryModule],
      providers: [
        BullmqJobQueue,
        { provide: JobQueue, useExisting: BullmqJobQueue },
        BullmqJobScheduler,
        { provide: JobScheduler, useExisting: BullmqJobScheduler },
        { provide: WORKER_HOST_OPTIONS, useValue: opts },
        WorkerHost,
      ],
      exports: [JobQueue, BullmqJobQueue, JobScheduler, WorkerHost],
    };
  }
}
