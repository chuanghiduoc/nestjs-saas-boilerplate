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
import { undiciInstrumentationConfig } from './outbound-span-policy.js';
import { PiiScrubbingSpanExporter } from './span-pii-policy.js';

type AutoInstrumentation = ReturnType<
  typeof getNodeAutoInstrumentations
>[number];
type WithModuleDefinitions = AutoInstrumentation & {
  getModuleDefinitions(): { name: string }[];
};

let sdk: NodeSDK | undefined;
let hookedModules: string[] = [];

/**
 * Tên module (npm hoặc built-in) mà các instrumentation đã bật hook: đúng tập tên mà
 * `InstrumentationBase.enable()` đưa cho `Hook` của import-in-the-middle. `getModuleDefinitions()` có
 * trên `InstrumentationBase` (đánh dấu experimental, không có trong interface `Instrumentation`), nên
 * kiểm lúc chạy và ném lỗi thay vì âm thầm bỏ sót module khi một bản nâng cấp đổi API.
 */
export function moduleNames(list: AutoInstrumentation[]): string[] {
  const names = list.flatMap((i) => {
    if (
      typeof (i as Partial<WithModuleDefinitions>).getModuleDefinitions !==
      'function'
    )
      throw new Error(
        `instrumentation ${i.instrumentationName} has no getModuleDefinitions(); cannot build the ESM hook include list`,
      );
    return (i as WithModuleDefinitions)
      .getModuleDefinitions()
      .map((m) => m.name);
  });
  return [...new Set(names)];
}

/**
 * Instrumentation app bật, với config của core. `startTelemetry` và test telemetry dùng chung hàm này, để test chạy đúng
 * config của production.
 */
export function autoInstrumentations(): AutoInstrumentation[] {
  return getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    // dns/net chỉ sinh trace gốc cho mỗi lần mở connection (pool, BullMQ reconnect); span
    // http/pg/ioredis đã đủ chi tiết.
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    // Express 5 dùng package `router`: instrumentation express đã ghi từng layer, router ghi lại lần hai với `http.route` =
    // `req.baseUrl` thô. Middleware mount theo pattern thì đó là path thật của request (path có thể chứa token, vd. Better
    // Auth `/reset-password/:token`), đặt vào attribute và tên span.
    '@opentelemetry/instrumentation-router': { enabled: false },
    // Giữ gắn trace_id/span_id vào log pino, bỏ gửi bản sao log sang OTel.
    '@opentelemetry/instrumentation-pino': { disableLogSending: true },
    // Vòng poll của BullMQ (lệnh chặn) và relay outbox chạy ngoài request: không tạo trace gốc
    // cho mỗi lệnh Redis/SQL nền, chỉ ghi span khi nằm trong một trace có sẵn.
    '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
    '@opentelemetry/instrumentation-pg': { requireParentSpan: true },
    // Review cuối 6C (I-A): request webhook không có span/metric client; request khác mất query trong `url.full`.
    '@opentelemetry/instrumentation-undici': undiciInstrumentationConfig,
  });
}

/**
 * Idempotent; OTel tắt thì không làm gì (API OTel dùng bản no-op) và trả `[]`. Trả tên các module
 * được hook, để `instrumentation.ts` chỉ cho loader ESM bọc đúng các module đó.
 */
export function startTelemetry(cfg: ConfigOf<typeof otelConfig>): string[] {
  if (!cfg.enabled || sdk) return hookedModules;
  if (!cfg.endpoint)
    throw new Error(
      'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true',
    );
  const base = cfg.endpoint.replace(/\/+$/, '');
  const instrumentations = autoInstrumentations();
  const ratio = new TraceIdRatioBasedSampler(cfg.sampleRatio);
  sdk = new NodeSDK({
    serviceName: cfg.serviceName,
    // Spec §15: mọi span đi qua chính sách PII trước khi rời process (span-pii-policy.ts).
    traceExporter: new PiiScrubbingSpanExporter(
      new OTLPTraceExporter({
        url: `${base}/v1/traces`,
        timeoutMillis: cfg.exportTimeoutMs,
      }),
    ),
    metricReaders: [
      new metrics.PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${base}/v1/metrics`,
          timeoutMillis: cfg.exportTimeoutMs,
        }),
        exportIntervalMillis: cfg.metricsIntervalMs,
        exportTimeoutMillis: cfg.exportTimeoutMs,
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
    instrumentations,
  });
  sdk.start();
  hookedModules = moduleNames(instrumentations);
  return hookedModules;
}

/** Gọi **sau** `app.close()` để span/metric của giai đoạn tắt cũng được gửi đi. Chưa start thì no-op. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  const s = sdk;
  sdk = undefined;
  await s.shutdown();
}
