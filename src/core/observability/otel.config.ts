import { z } from 'zod';
import { defineConfig } from '../config/index.js';

/**
 * Không đọc `appConfig`: `instrumentation.ts` (nạp bằng `--import`) chạy trước khi entrypoint
 * đặt `APP_ROLE`, nên config OTel phải parse được độc lập.
 */
export const otelConfig = defineConfig(
  'otel',
  {
    enabled: 'OTEL_ENABLED',
    endpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    serviceName: 'OTEL_SERVICE_NAME',
    sampleRatio: 'OTEL_TRACES_SAMPLE_RATIO',
    metricsIntervalMs: 'OTEL_METRICS_INTERVAL_MS',
    exportTimeoutMs: 'OTEL_EXPORTER_OTLP_TIMEOUT',
  },
  z
    .object({
      enabled: z
        .stringbool()
        .default(false)
        .describe('Enable OpenTelemetry export'),
      endpoint: z
        .url()
        .optional()
        .describe('OTLP HTTP endpoint base URL (required when enabled)'),
      serviceName: z
        .string()
        .min(1)
        .default('backend-demo')
        .describe('service.name resource attribute'),
      sampleRatio: z.coerce
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .describe(
          'Head sampling ratio for new traces and for remote parents sent by clients',
        ),
      metricsIntervalMs: z.coerce
        .number()
        .int()
        .positive()
        .default(15000)
        .describe(
          'Metric export interval; also how often queue/outbox gauges query Redis and the DB',
        ),
      exportTimeoutMs: z.coerce
        .number()
        .int()
        .positive()
        .default(3000)
        .describe(
          'Timeout of one OTLP export (traces and metrics), including the final flush on shutdown; must stay below APP_SHUTDOWN_RESERVE_MS',
        ),
    })
    .refine((c) => !c.enabled || c.endpoint, {
      message: 'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true',
      path: ['endpoint'],
    })
    // PeriodicExportingMetricReader ném lỗi lúc khởi động nếu timeout lớn hơn chu kỳ export.
    .refine((c) => c.exportTimeoutMs <= c.metricsIntervalMs, {
      message:
        'OTEL_EXPORTER_OTLP_TIMEOUT must not exceed OTEL_METRICS_INTERVAL_MS',
      path: ['exportTimeoutMs'],
    }),
);
