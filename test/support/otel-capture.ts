import { metrics } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

class TestReader extends sdkMetrics.MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
export type OtelCapture = {
  /** Tổng value của mọi datapoint khớp tên + attribute (counter/gauge); không có thì undefined. */
  metric(
    name: string,
    attrs?: Record<string, string>,
  ): Promise<number | undefined>;
  /** Mọi datapoint của các metric có tên bắt đầu bằng `prefix` (kiểm label, Task 40). */
  dataPoints(
    prefix: string,
  ): Promise<{ name: string; attributes: Record<string, unknown> }[]>;
  allSpans(): ReadableSpan[];
  spanNames(): string[];
  spans(name: string): ReadableSpan[];
  reset(): void;
};

/**
 * Một lần mỗi file test (global provider chỉ đặt được một lần mỗi process; Vitest cô lập theo file). `wrapExporter` đặt
 * exporter của production (vd. `PiiScrubbingSpanExporter`) trước exporter trong bộ nhớ: test thấy đúng span sẽ được gửi đi.
 */
export function installOtelCapture(
  wrapExporter: (inner: SpanExporter) => SpanExporter = (inner) => inner,
): OtelCapture {
  const exporter = new InMemorySpanExporter();
  const reader = new TestReader();
  new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(wrapExporter(exporter))],
  }).register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
  });
  metrics.setGlobalMeterProvider(
    new sdkMetrics.MeterProvider({ readers: [reader] }),
  );
  return {
    async metric(name, attrs = {}) {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length)
        throw new Error(
          `metric collection failed: ${errors.map(String).join('; ')}`,
        );
      let total: number | undefined;
      for (const scope of resourceMetrics.scopeMetrics)
        for (const m of scope.metrics) {
          if (m.descriptor.name !== name) continue;
          if (
            m.dataPointType !== sdkMetrics.DataPointType.GAUGE &&
            m.dataPointType !== sdkMetrics.DataPointType.SUM
          )
            throw new Error(`${name} is not a gauge or sum`);
          for (const dp of m.dataPoints)
            if (Object.entries(attrs).every(([k, v]) => dp.attributes[k] === v))
              total = (total ?? 0) + dp.value;
        }
      return total;
    },
    async dataPoints(prefix) {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length)
        throw new Error(
          `metric collection failed: ${errors.map(String).join('; ')}`,
        );
      return resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics
          .filter((m) => m.descriptor.name.startsWith(prefix))
          .flatMap((m) =>
            m.dataPoints.map((dp) => ({
              name: m.descriptor.name,
              attributes: { ...dp.attributes },
            })),
          ),
      );
    },
    allSpans: () => exporter.getFinishedSpans(),
    spanNames: () => exporter.getFinishedSpans().map((s) => s.name),
    spans: (name) => exporter.getFinishedSpans().filter((s) => s.name === name),
    reset: () => exporter.reset(),
  };
}
