import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const httpConfig = defineConfig(
  'http',
  { port: 'HTTP_PORT', host: 'HTTP_HOST' },
  z.object({
    port: z.coerce
      .number()
      .int()
      .min(0)
      .default(3000)
      .describe('HTTP listen port'),
    host: z.string().default('0.0.0.0').describe('HTTP listen host'),
  }),
);
