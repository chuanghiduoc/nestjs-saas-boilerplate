import { type DynamicModule, Module } from '@nestjs/common';
import { ScheduleReconciler } from './schedule-reconciler.js';
import { ScheduledTaskService } from './scheduled-task.service.js';
import { ReconcileSchedulesHandler } from './scheduler.jobs.js';
import { StaticScheduler } from './static-scheduler.js';

/** `worker: true` chỉ trong worker (reconciler cần `DatabaseModule.forRoot({ relay: true })` cho `RelayDb`). */
@Module({})
export class SchedulerModule {
  static forRoot(opts: { worker: boolean }): DynamicModule {
    const worker = opts.worker
      ? [StaticScheduler, ScheduleReconciler, ReconcileSchedulesHandler]
      : [];
    return {
      module: SchedulerModule,
      global: true,
      providers: [ScheduledTaskService, ...worker],
      exports: [ScheduledTaskService, ...worker],
    };
  }
}
