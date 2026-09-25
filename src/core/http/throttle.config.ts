import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const MS_PER_SEC = 1000;

export const throttleConfig = defineConfig(
  'throttle',
  { limit: 'THROTTLE_DEFAULT_LIMIT', ttlMs: 'THROTTLE_DEFAULT_TTL_MS' },
  z.object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .default(300)
      .describe(
        'Default requests per window per tracker (principal+org, else client IP)',
      ),
    // rate-limiter-flexible đếm cửa sổ theo giây nguyên (ADR 0007), nên không nhận phần lẻ của giây.
    ttlMs: z.coerce
      .number()
      .int()
      .positive()
      .multipleOf(MS_PER_SEC)
      .default(60000)
      .describe('Default rate limit window (ms, whole seconds)'),
  }),
);
