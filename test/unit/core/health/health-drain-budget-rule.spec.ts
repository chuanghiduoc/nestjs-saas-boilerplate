import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../../src/core/config/index.js';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { healthConfig } from '../../../../src/core/health/health.config.js';
import { otelConfig } from '../../../../src/core/observability/otel.config.js';
import { queueConfig } from '../../../../src/core/queue/queue.config.js';

const K8S_DEFAULT_GRACE_MS = 30_000;

const rule = (name: string) => {
  const r = configRuleRegistry().find((x) => x.name === name);
  if (!r) throw new Error(`${name} rule not registered`);
  return r.rule({
    app: appConfig(),
    queue: queueConfig(),
    otel: otelConfig(),
    health: healthConfig(),
  });
};

describe('health drain budget rule (api shutdown)', () => {
  beforeEach(() => vi.stubEnv('APP_ROLE', 'api'));
  afterEach(() => vi.unstubAllEnvs());

  it('defaults fit both roles under the hard deadline and the k8s grace period', () => {
    const app = appConfig();
    const health = healthConfig();
    const queue = queueConfig();
    expect(health.drainDelayMs).toBe(5_000);
    expect(health.checkTimeoutMs).toBe(1_000);
    // api: drain delay + reserve; worker: queue drain + abort grace + reserve.
    expect(health.drainDelayMs + app.shutdownReserveMs).toBeLessThanOrEqual(
      app.shutdownTimeoutMs,
    );
    expect(
      queue.shutdownTimeoutMs +
        queue.shutdownAbortGraceMs +
        app.shutdownReserveMs,
    ).toBeLessThanOrEqual(app.shutdownTimeoutMs);
    expect(app.shutdownTimeoutMs).toBeLessThan(K8S_DEFAULT_GRACE_MS);
    expect(rule('health-drain-budget')).toBeUndefined();
    expect(rule('shutdown-budget')).toBeUndefined();
  });

  it('rejects a drain delay that leaves no reserve before the hard deadline', () => {
    vi.stubEnv('HEALTH_DRAIN_DELAY_MS', '22001');
    expect(rule('health-drain-budget')).toMatch(
      /APP_SHUTDOWN_TIMEOUT_MS \(28000\) must be at least HEALTH_DRAIN_DELAY_MS \+ APP_SHUTDOWN_RESERVE_MS \(28001\)/,
    );
    vi.stubEnv('HEALTH_DRAIN_DELAY_MS', '22000');
    expect(rule('health-drain-budget')).toBeUndefined();
  });
});
