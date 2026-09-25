import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, metrics } from '@opentelemetry/sdk-node';
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import type { ConfigOf } from '../config/index.js';
import type { otelConfig } from './otel.config.js';

let sdk: NodeSDK | undefined;

/** Idempotent; OTel tắt thì không làm gì (API OTel dùng bản no-op). */
export function startTelemetry(cfg: ConfigOf<typeof otelConfig>): void {
  if (!cfg.enabled || sdk) return;
  if (!cfg.endpoint)
    throw new Error(
      'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true',
    );
  const base = cfg.endpoint.replace(/\/+$/, '');
  const ratio = new TraceIdRatioBasedSampler(cfg.sampleRatio);
  sdk = new NodeSDK({
    serviceName: cfg.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReaders: [
      new metrics.PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: cfg.metricsIntervalMs,
      }),
    ],
    // traceparent từ client không được ép lấy mẫu 100%: parent từ xa được lấy mẫu lại theo ratio.
    // TraceIdRatioBasedSampler quyết định theo traceId, nên job (parent từ xa lấy từ meta) nhận
    // đúng quyết định của request gốc cùng trace.
    sampler: new ParentBasedSampler({
      root: ratio,
      remoteParentSampled: ratio,
      remoteParentNotSampled: ratio,
    }),
    // Log đi stdout (pino, đã redact); không gửi log qua OTLP. Không truyền thì NodeSDK tự tạo
    // exporter log OTLP theo env mặc định (`OTEL_LOGS_EXPORTER` rỗng = otlp).
    logRecordProcessors: [],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // dns/net chỉ sinh trace gốc cho mỗi lần mở connection (pool, BullMQ reconnect); span
        // http/pg/ioredis đã đủ chi tiết.
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Giữ gắn trace_id/span_id vào log pino, bỏ gửi bản sao log sang OTel.
        '@opentelemetry/instrumentation-pino': { disableLogSending: true },
        // Vòng poll của BullMQ (lệnh chặn) và relay outbox chạy ngoài request: không tạo trace gốc
        // cho mỗi lệnh Redis/SQL nền, chỉ ghi span khi nằm trong một trace có sẵn.
        '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
        '@opentelemetry/instrumentation-pg': { requireParentSpan: true },
      }),
    ],
  });
  sdk.start();
}

/** Gọi **sau** `app.close()` để span/metric của giai đoạn tắt cũng được gửi đi. Chưa start thì no-op. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  const s = sdk;
  sdk = undefined;
  await s.shutdown();
}
