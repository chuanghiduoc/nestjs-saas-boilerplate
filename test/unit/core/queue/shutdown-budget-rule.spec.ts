import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../../src/core/config/index.js';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { otelConfig } from '../../../../src/core/observability/otel.config.js';
import { queueConfig } from '../../../../src/core/queue/queue.config.js';

const K8S_DEFAULT_GRACE_MS = 30_000;

const check = () => {
  const r = configRuleRegistry().find((x) => x.name === 'shutdown-budget');
  if (!r) throw new Error('shutdown-budget rule not registered');
  return r.rule({ app: appConfig(), queue: queueConfig(), otel: otelConfig() });
};

describe('shutdown budget rule', () => {
  beforeEach(() => vi.stubEnv('APP_ROLE', 'worker'));
  afterEach(() => vi.unstubAllEnvs());

  it('defaults fit: drain + abort grace + reserve <= hard deadline < k8s grace', () => {
    const app = appConfig();
    const queue = queueConfig();
    expect(queue.shutdownTimeoutMs).toBe(18_000);
    expect(queue.shutdownAbortGraceMs).toBe(4_000);
    expect(app.shutdownReserveMs).toBe(6_000);
    expect(otelConfig().exportTimeoutMs).toBe(3_000);
    expect(app.shutdownTimeoutMs).toBe(28_000);
    expect(app.shutdownTimeoutMs).toBeLessThan(K8S_DEFAULT_GRACE_MS);
    expect(check()).toBeUndefined();
  });

  it('rejects a hard deadline that leaves no reserve after the queue drain', () => {
    vi.stubEnv('APP_SHUTDOWN_TIMEOUT_MS', '27999');
    expect(check()).toMatch(
      /APP_SHUTDOWN_TIMEOUT_MS \(27999\) must be at least QUEUE_SHUTDOWN_TIMEOUT_MS \+ QUEUE_SHUTDOWN_ABORT_GRACE_MS \+ APP_SHUTDOWN_RESERVE_MS \(28000\)/,
    );
    vi.stubEnv('QUEUE_SHUTDOWN_ABORT_GRACE_MS', '3999');
    expect(check()).toBeUndefined();
  });

  it('rejects a reserve that the OTLP export timeout alone would use up', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_TIMEOUT', '6000');
    expect(check()).toMatch(
      /APP_SHUTDOWN_RESERVE_MS \(6000\) must be greater than OTEL_EXPORTER_OTLP_TIMEOUT \(6000\)/,
    );
  });
});
