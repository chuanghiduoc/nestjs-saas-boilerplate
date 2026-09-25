import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const loggingConfig = defineConfig(
  'logging',
  {
    level: 'LOG_LEVEL',
    extraRedact: 'LOG_EXTRA_REDACT_PATHS',
  },
  z.object({
    level: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info')
      .describe('Minimum log level'),
    extraRedact: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      )
      .describe('Extra pino redact paths, added to the built-in list'),
  }),
);
