import { afterEach, describe, expect, it } from 'vitest';
import {
  otelConfig,
  shutdownTelemetry,
  startTelemetry,
} from '../../../../src/core/observability/index.js';

// Cổng 9 (discard) trên loopback: lần export cuối lúc shutdown bị từ chối ngay, không treo test.
const enabled = otelConfig.schema.parse({
  enabled: 'true',
  endpoint: 'http://127.0.0.1:9',
  exportTimeoutMs: '200',
});

describe('startTelemetry', () => {
  afterEach(() => shutdownTelemetry());

  it('returns no module to hook when OTel is disabled', () => {
    expect(startTelemetry(otelConfig.schema.parse({}))).toEqual([]);
  });

  // instrumentation.ts đưa danh sách này làm `include` của loader ESM: module nào thiếu ở đây thì
  // `import` của app không bị patch và mất span (spec §13: http, pg, ioredis; log pino có trace_id).
  it('returns the modules the ESM loader must wrap for the traced libraries', () => {
    const names = startTelemetry(enabled);
    expect(names).toEqual(
      expect.arrayContaining([
        'http',
        'https',
        'express',
        'pg',
        'ioredis',
        'pino',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    // Instrumentation đã tắt không được hook.
    expect(names).not.toContain('fs');
    expect(names).not.toContain('net');
    expect(names).not.toContain('dns');
  });
});
