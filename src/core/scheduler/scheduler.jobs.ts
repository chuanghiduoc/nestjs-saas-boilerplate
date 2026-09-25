import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { JobHandler, MaintenanceQueue, defineJob } from '../queue/index.js';
import { defineCron } from './cron-definition.js';
import { ScheduleReconciler } from './schedule-reconciler.js';
import { schedulerConfig } from './scheduler.config.js';

export const ReconcileSchedulesJob = defineJob({
  name: 'core.scheduler.reconcile',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
defineCron({
  key: 'core.scheduler.reconcile',
  job: ReconcileSchedulesJob,
  payload: {},
  schedule: () => {
    const c = schedulerConfig();
    return { cron: c.reconcileCron, tz: c.reconcileTz };
  },
});

@Injectable()
@JobHandler(ReconcileSchedulesJob)
export class ReconcileSchedulesHandler {
  constructor(private readonly reconciler: ScheduleReconciler) {}

  async handle(): Promise<void> {
    await this.reconciler.reconcile();
  }
}
