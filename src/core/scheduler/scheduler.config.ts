import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const schedulerConfig = defineConfig(
  'scheduler',
  {
    reconcileCron: 'SCHEDULER_RECONCILE_CRON',
    reconcileTz: 'SCHEDULER_RECONCILE_TZ',
    tenantMinIntervalSec: 'SCHEDULER_TENANT_MIN_INTERVAL_SEC',
  },
  z.object({
    reconcileCron: z
      .string()
      .min(1)
      .default('*/10 * * * *')
      .describe(
        'Cron for reconciling scheduled_tasks with the queue (also bounds how long a lost or drifted tenant schedule stays wrong)',
      ),
    reconcileTz: z
      .string()
      .min(1)
      .default('UTC')
      .describe('Timezone for the reconcile cron'),
    tenantMinIntervalSec: z.coerce
      .number()
      .int()
      .positive()
      .default(300)
      .describe(
        'Minimum interval between runs of a tenant-defined schedule (checked on the time-of-day grid, day boundary included)',
      ),
  }),
);
