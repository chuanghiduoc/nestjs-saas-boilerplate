import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../../src/core/config/index.js';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { queueConfig } from '../../../../src/core/queue/queue.config.js';

const check = () => {
  const r = configRuleRegistry().find((x) => x.name === 'shutdown-budget');
  if (!r) throw new Error('shutdown-budget rule not registered');
  return r.rule({ app: appConfig(), queue: queueConfig() });
};

describe('shutdown budget rule', () => {
  beforeEach(() => vi.stubEnv('APP_ROLE', 'worker'));
  afterEach(() => vi.unstubAllEnvs());

  it('defaults fit: drain + abort grace < hard deadline', () => {
    expect(appConfig().shutdownTimeoutMs).toBe(28_000);
    expect(check()).toBeUndefined();
  });

  it('rejects a hard deadline that would cut the queue drain short', () => {
    vi.stubEnv('APP_SHUTDOWN_TIMEOUT_MS', '25000');
    expect(check()).toMatch(
      /APP_SHUTDOWN_TIMEOUT_MS \(25000\) must be greater than QUEUE_SHUTDOWN_TIMEOUT_MS \+ QUEUE_SHUTDOWN_ABORT_GRACE_MS \(25000\)/,
    );
    vi.stubEnv('QUEUE_SHUTDOWN_ABORT_GRACE_MS', '4000');
    expect(check()).toBeUndefined();
  });
});
