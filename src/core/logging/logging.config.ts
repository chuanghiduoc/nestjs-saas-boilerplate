import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';

export const loggingConfig = defineConfig(
  'logging',
  {
    level: 'LOG_LEVEL',
    extraRedact: 'LOG_EXTRA_REDACT_PATHS',
    pretty: 'LOG_PRETTY',
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
    pretty: z
      .stringbool()
      .default(false)
      .describe('Human readable logs (local dev only)'),
  }),
);

defineProductionRule('logging-no-pretty', (c) =>
  c.logging?.pretty ? 'LOG_PRETTY must be false in production' : undefined,
);
