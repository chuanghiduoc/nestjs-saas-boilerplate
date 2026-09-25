import { z } from 'zod';
import { defineConfig, defineConfigRule } from '../config/index.js';

const MAX_PORT = 65535;

export const healthConfig = defineConfig(
  'health',
  {
    checkTimeoutMs: 'HEALTH_CHECK_TIMEOUT_MS',
    drainDelayMs: 'HEALTH_DRAIN_DELAY_MS',
    workerPort: 'WORKER_HEALTH_PORT',
    workerHost: 'WORKER_HEALTH_HOST',
  },
  z.object({
    checkTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(500)
      .describe(
        'Timeout of each readiness check; a slower dependency counts as down. Must stay below the readiness probe timeoutSeconds (Kubernetes default 1s) so the probe gets a clean 503, not a timeout. Checks: api = DB only (Redis is shared and the api degrades without it, ruling R21); worker = DB + Redis',
      ),
    drainDelayMs: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(5000)
      .describe(
        'api only: after SIGTERM, readiness answers 503 for this long before the HTTP server closes, so the load balancer stops routing first. The worker never waits for it (no load balancer). HEALTH_DRAIN_DELAY_MS + APP_SHUTDOWN_RESERVE_MS must fit in APP_SHUTDOWN_TIMEOUT_MS',
      ),
    workerPort: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_PORT)
      .default(3001)
      .describe(
        'Port of the worker health server (/health/live, /health/ready); 0 = any free port',
      ),
    workerHost: z
      .string()
      .min(1)
      .default('0.0.0.0')
      .describe('Listen host of the worker health server'),
  }),
);

/**
 * Ngân sách tắt của api (bổ sung cho luật `shutdown-budget` của queue, là ngân sách của worker):
 * api chờ `HEALTH_DRAIN_DELAY_MS` trong `beforeApplicationShutdown` (ShutdownCoordinator) rồi mới
 * đóng HTTP, DB, Redis và flush telemetry trong phần dự phòng, nên hạn chót cứng phải chứa được
 * drain delay + dự phòng.
 * - api không bao giờ trả chi phí drain queue (`runWorkers: false`, WorkerHost không có worker);
 * - worker không bao giờ trả `HEALTH_DRAIN_DELAY_MS` (không đăng ký ShutdownCoordinator).
 * Hai luật cùng đạt nghĩa là hạn chót >= max(chi phí api, chi phí worker) + dự phòng; mặc định
 * api 5s + 6s = 11s, worker 5s + 13s + 4s + 6s = 28s, cả hai <= 28s < 30s grace của Kubernetes.
 * Luật "dự phòng > timeout OTLP" đã nằm trong `shutdown-budget`.
 */
defineConfigRule('health-drain-budget', (c) => {
  const deadlineMs = c.app?.shutdownTimeoutMs;
  const reserveMs = c.app?.shutdownReserveMs;
  const drainDelayMs = c.health?.drainDelayMs;
  if (
    typeof deadlineMs !== 'number' ||
    typeof reserveMs !== 'number' ||
    typeof drainDelayMs !== 'number'
  )
    return 'health drain budget rule needs the app and health config namespaces';
  if (deadlineMs < drainDelayMs + reserveMs)
    return `APP_SHUTDOWN_TIMEOUT_MS (${deadlineMs}) must be at least HEALTH_DRAIN_DELAY_MS + APP_SHUTDOWN_RESERVE_MS (${drainDelayMs + reserveMs})`;
  return undefined;
});
