import { z } from 'zod';
import { defineConfig } from '../config/index.js';
import {
  isValidCron,
  normalizeTimezone,
} from '../scheduler/schedule-validation.js';

export const partitionsConfig = defineConfig(
  'partitions',
  {
    maintainCron: 'PARTITIONS_MAINTAIN_CRON',
    maintainTz: 'PARTITIONS_MAINTAIN_TZ',
  },
  z.object({
    maintainCron: z
      .string()
      .min(1)
      .refine(isValidCron, 'must be a valid cron expression')
      .default('30 0 * * *')
      .describe(
        'Cron of core.partitions.maintain: premake next months and drop expired monthly partitions',
      ),
    maintainTz: z
      .string()
      .min(1)
      .refine(
        (tz) => normalizeTimezone(tz) !== undefined,
        'must be an IANA timezone name',
      )
      .default('UTC')
      .describe(
        'Timezone for the partition maintenance cron (partition bounds are always UTC months)',
      ),
  }),
);
