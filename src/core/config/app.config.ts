import { z } from 'zod';
import { defineConfig } from './define-config.js';

export const appConfig = defineConfig(
  'app',
  { role: 'APP_ROLE', nodeEnv: 'NODE_ENV', serviceName: 'APP_SERVICE_NAME' },
  z.object({
    role: z
      .enum(['api', 'worker', 'migrate'])
      .describe('Process role, set by the entrypoint'),
    nodeEnv: z
      .enum(['development', 'test', 'production'])
      .default('development')
      .describe('Runtime environment'),
    serviceName: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default('backend-demo')
      .describe('Service name used in logs and key namespaces'),
  }),
);
