import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../queue/index.js';
import { defineCron } from '../scheduler/cron-definition.js';
import { partitionsConfig } from './partitions.config.js';

/** Một cron chung cho mọi bảng partitioned (spec SP6 §5.3, §10). */
export const MaintainPartitionsJob = defineJob({
  name: 'core.partitions.maintain',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
defineCron({
  key: 'core.partitions.maintain',
  job: MaintainPartitionsJob,
  payload: {},
  schedule: () => {
    const c = partitionsConfig();
    return { cron: c.maintainCron, tz: c.maintainTz };
  },
});
