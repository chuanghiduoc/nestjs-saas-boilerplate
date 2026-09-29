import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const flagsConfig = defineConfig(
  'flags',
  { refreshIntervalMs: 'FLAGS_REFRESH_INTERVAL_MS' },
  z.object({
    refreshIntervalMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60000)
      .default(5000)
      .describe(
        'How often every api/worker process reloads kill switches from the database; a change takes effect within this interval + 1 s',
      ),
  }),
);
