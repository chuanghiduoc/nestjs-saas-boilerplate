import { type DynamicModule, Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullmqJobQueue } from './bullmq-job-queue.js';
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
        { provide: WORKER_HOST_OPTIONS, useValue: opts },
        WorkerHost,
      ],
      exports: [JobQueue, BullmqJobQueue, WorkerHost],
    };
  }
}
