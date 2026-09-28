import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResiliencePolicies,
  resilienceConfig,
} from '../../../../src/core/resilience/index.js';

const SLOW_MS = 1000;
const FAST_TIMEOUT_MS = 20;
const QUICK_TASK_MS = 60;

/** Task chờ `ms` rồi trả 'done'; bị huỷ qua signal thì reject ngay. */
const sleepTask =
  (ms: number) =>
  ({ signal }: { signal: AbortSignal }) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => resolve('done'), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    });

const policies = (env: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({
    RESILIENCE_DEFAULT_TIMEOUT_MS: '10000',
    RESILIENCE_DEFAULT_RETRIES: '0',
    ...env,
  }))
    vi.stubEnv(k, v);
  return new ResiliencePolicies(resilienceConfig());
};

describe('ResiliencePolicies.setProviderDefaults', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a provider default replaces the global default for that provider only', async () => {
    const p = policies();
    p.setProviderDefaults('idp', { timeoutMs: FAST_TIMEOUT_MS });
    await expect(
      p.for('idp').single.execute(sleepTask(SLOW_MS)),
    ).rejects.toThrow();
    expect(await p.for('other').single.execute(sleepTask(QUICK_TASK_MS))).toBe(
      'done',
    );
  });
  it('RESILIENCE_OVERRIDES still wins over the provider default', async () => {
    const p = policies({
      RESILIENCE_OVERRIDES: JSON.stringify({ idp: { timeoutMs: 5000 } }),
    });
    p.setProviderDefaults('idp', { timeoutMs: FAST_TIMEOUT_MS });
    expect(await p.for('idp').single.execute(sleepTask(QUICK_TASK_MS))).toBe(
      'done',
    );
  });
  it('setting defaults twice, or after the policy was built, is a wiring error', () => {
    const p = policies();
    p.setProviderDefaults('idp', { timeoutMs: FAST_TIMEOUT_MS });
    expect(() => p.setProviderDefaults('idp', { timeoutMs: 1 })).toThrow(
      /must be set once, before its first call/,
    );
    p.for('late');
    expect(() => p.setProviderDefaults('late', { timeoutMs: 1 })).toThrow(
      /must be set once, before its first call/,
    );
  });
});
