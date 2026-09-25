import { describe, expect, it, vi } from 'vitest';
import {
  SsrfBlockedError,
  UpstreamError,
  buildPolicies,
} from '../../../../src/core/resilience/index.js';

const cfg = {
  timeoutMs: 100,
  retries: 2,
  retryBaseMs: 1,
  breakerThreshold: 3,
  breakerHalfOpenMs: 50,
  bulkheadLimit: 2,
  bulkheadQueue: 0,
};

describe('resilience policies', () => {
  it('retrying policy retries transient failures then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok');
    expect(await buildPolicies(cfg).retrying.execute(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('single policy never retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(buildPolicies(cfg).single.execute(fn)).rejects.toThrow(
      'ECONNRESET',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('times out slow calls and aborts the signal handed to the call', async () => {
    const p = buildPolicies({ ...cfg, retries: 0 }).single;
    let aborted = false;
    await expect(
      p.execute(
        ({ signal }) =>
          new Promise((r, j) => {
            const t = setTimeout(r, 1000);
            signal.addEventListener('abort', () => {
              aborted = true;
              clearTimeout(t);
              j(new Error('aborted'));
            });
          }),
      ),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
  });
  it('both variants share one breaker', async () => {
    const { retrying, single } = buildPolicies({ ...cfg, retries: 0 });
    const fail = () => Promise.reject(new Error('down'));
    for (let i = 0; i < 3; i++)
      await expect(single.execute(fail)).rejects.toThrow('down');
    await expect(retrying.execute(() => Promise.resolve('x'))).rejects.toThrow(
      /open|broken/i,
    );
  });
  it('both variants share one bulkhead', async () => {
    const { retrying, single } = buildPolicies({ ...cfg, bulkheadLimit: 1 });
    let release = () => {};
    const held = single.execute(() => new Promise<void>((r) => (release = r)));
    await expect(retrying.execute(() => Promise.resolve('x'))).rejects.toThrow(
      /bulkhead/i,
    );
    release();
    await held;
  });
  it('SSRF blocks and non-retryable upstream errors are neither retried nor counted by the breaker', async () => {
    const { retrying } = buildPolicies({ ...cfg, breakerThreshold: 1 });
    const blocked = vi
      .fn()
      .mockRejectedValue(new SsrfBlockedError('Destination x is not allowed'));
    await expect(retrying.execute(blocked)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(blocked).toHaveBeenCalledTimes(1);
    const tooLarge = vi
      .fn()
      .mockRejectedValue(new UpstreamError('p', 'too_large', 'too big'));
    await expect(retrying.execute(tooLarge)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(tooLarge).toHaveBeenCalledTimes(1);
    expect(await retrying.execute(() => Promise.resolve('still closed'))).toBe(
      'still closed',
    );
  });
});
