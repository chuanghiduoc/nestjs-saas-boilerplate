import { z } from 'zod';
import { type ConfigOf, defineConfig } from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { DEFINER_LIMIT_MAX } from '../../core/sweep/index.js';

/** Giới hạn của spec SP7 §11.1. Không trường nào là secret. */
const RETENTION_MIN_SEC = 3600;
const RETENTION_MAX_SEC = 31_536_000;
const MAX_BATCHES_MAX = 1000;
const ROWS_PER_JOB_MAX = 10_000;

const positiveInt = z.coerce.number().int().positive();
const cron = z
  .string()
  .min(1)
  .refine(isValidCron, 'must be a valid cron expression');
const timezone = z
  .string()
  .min(1)
  .refine(
    (tz) => normalizeTimezone(tz) !== undefined,
    'must be an IANA timezone name',
  );

export const exampleConfig = defineConfig(
  'example',
  {
    archivedRetentionSec: 'EXAMPLE_ARCHIVED_RETENTION_SEC',
    purgeCron: 'EXAMPLE_PURGE_CRON',
    purgeTz: 'EXAMPLE_PURGE_TZ',
    purgeOrgBatchSize: 'EXAMPLE_PURGE_ORG_BATCH_SIZE',
    purgeMaxBatches: 'EXAMPLE_PURGE_MAX_BATCHES',
    purgeRowsPerJob: 'EXAMPLE_PURGE_ROWS_PER_JOB',
  },
  z.object({
    archivedRetentionSec: positiveInt
      .min(RETENTION_MIN_SEC)
      .max(RETENTION_MAX_SEC)
      .default(2_592_000)
      .describe('Seconds an archived project is kept before it is deleted'),
    purgeCron: cron
      .default('30 3 * * *')
      .describe('Cron of example.projects.purge-archived'),
    purgeTz: timezone
      .default('UTC')
      .describe('Timezone of the archived project purge cron'),
    purgeOrgBatchSize: positiveInt
      .max(DEFINER_LIMIT_MAX)
      .default(100)
      .describe('Organizations per purge sweep batch'),
    purgeMaxBatches: positiveInt
      .max(MAX_BATCHES_MAX)
      .default(10)
      .describe('Max purge sweep batches per cron run'),
    purgeRowsPerJob: positiveInt
      .max(ROWS_PER_JOB_MAX)
      .default(1000)
      .describe('Archived projects one per-organization purge job deletes'),
  }),
);
export type ExampleConfig = ConfigOf<typeof exampleConfig>;
