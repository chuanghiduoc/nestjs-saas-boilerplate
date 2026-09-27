import { metrics } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
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
  spanNames(): string[];
  spans(name: string): ReadableSpan[];
  reset(): void;
};

/** Một lần mỗi file test (global provider chỉ đặt được một lần mỗi process; Vitest cô lập theo file). */
export function installOtelCapture(): OtelCapture {
  const exporter = new InMemorySpanExporter();
  const reader = new TestReader();
  new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
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
    spanNames: () => exporter.getFinishedSpans().map((s) => s.name),
    spans: (name) => exporter.getFinishedSpans().filter((s) => s.name === name),
    reset: () => exporter.reset(),
  };
}
