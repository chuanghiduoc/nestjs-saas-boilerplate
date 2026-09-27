import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../../core/queue/index.js';
import { defineCron } from '../../core/scheduler/index.js';
import { identityGuardConfig } from './identity.config.js';

export const ReconcileRegisteredJob = defineJob({
  name: 'identity.reconcile-registered',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
export const PurgeExpiredJob = defineJob({
  name: 'identity.purge-expired',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});

defineCron({
  key: 'identity.reconcile-registered',
  job: ReconcileRegisteredJob,
  payload: {},
  schedule: () => {
    const c = identityGuardConfig();
    return { cron: c.registeredReconcileCron, tz: c.registeredReconcileTz };
  },
});
defineCron({
  key: 'identity.purge-expired',
  job: PurgeExpiredJob,
  payload: {},
  schedule: () => {
    const c = identityGuardConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
});
