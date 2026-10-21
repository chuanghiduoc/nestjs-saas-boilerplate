import { z } from 'zod';
import { defineConfig } from './define-config.js';
import { APP_ROLES } from './secret-meta.js';

export const appConfig = defineConfig(
  'app',
  {
    role: 'APP_ROLE',
    nodeEnv: 'NODE_ENV',
    serviceName: 'APP_SERVICE_NAME',
    shutdownTimeoutMs: 'APP_SHUTDOWN_TIMEOUT_MS',
    shutdownReserveMs: 'APP_SHUTDOWN_RESERVE_MS',
  },
  z.object({
    role: z.enum(APP_ROLES).describe('Process role, set by the entrypoint'),
    nodeEnv: z
      .enum(['development', 'test', 'production'])
      .default('development')
      .describe('Runtime environment'),
    serviceName: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default('nestjs-saas-boilerplate')
      .describe('Service name used in logs and key namespaces'),
    shutdownTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(28000)
      .describe(
        'Hard deadline after SIGTERM/SIGINT: if closing the app and flushing telemetry takes longer, log an error and exit 1. Must be >= OUTBOX_ENQUEUE_TIMEOUT_MS + QUEUE_SHUTDOWN_TIMEOUT_MS + QUEUE_SHUTDOWN_ABORT_GRACE_MS + APP_SHUTDOWN_RESERVE_MS (worker) and >= HEALTH_DRAIN_DELAY_MS + APP_SHUTDOWN_RESERVE_MS (api), and below the orchestrator kill deadline (Kubernetes terminationGracePeriodSeconds, default 30s, minus any preStop sleep)',
      ),
    shutdownReserveMs: z.coerce
      .number()
      .int()
      .positive()
      .default(6000)
      .describe(
        'Part of APP_SHUTDOWN_TIMEOUT_MS kept after the worst-case relay stop and queue drain (worker) or the health drain delay (api) for closing HTTP, DB, Redis and the final OTLP flush; must exceed OTEL_EXPORTER_OTLP_TIMEOUT',
      ),
  }),
);
