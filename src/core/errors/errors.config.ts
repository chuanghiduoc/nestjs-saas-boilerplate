import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const errorsConfig = defineConfig(
  'errors',
  { problemTypeBase: 'HTTP_PROBLEM_TYPE_BASE' },
  z.object({
    problemTypeBase: z
      .string()
      .regex(/^(\/|https?:\/\/)[^\s]*[^/]$/)
      .default('/errors')
      .describe(
        'Base URI for problem "type" (docs page per error code), no trailing slash',
      ),
  }),
);
