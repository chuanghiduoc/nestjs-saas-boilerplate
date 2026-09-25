import { describe, expect, it } from 'vitest';
import { otelConfig } from '../../../../src/core/observability/index.js';

describe('otelConfig', () => {
  it('does not depend on APP_ROLE or appConfig', () => {
    expect(otelConfig.schema.parse({ enabled: 'false' })).toMatchObject({
      enabled: false,
    });
  });
  it('requires an endpoint when enabled', () => {
    expect(() => otelConfig.schema.parse({ enabled: 'true' })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });
  it('rejects an export timeout longer than the metric export interval', () => {
    expect(() =>
      otelConfig.schema.parse({
        exportTimeoutMs: '5000',
        metricsIntervalMs: '4000',
      }),
    ).toThrow(/OTEL_EXPORTER_OTLP_TIMEOUT must not exceed/);
  });
});
