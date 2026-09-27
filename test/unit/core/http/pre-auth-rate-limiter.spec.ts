import type { ThrottlerStorage } from '@nestjs/throttler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { clientIpTracker } from '../../../../src/core/http/client-ip.js';
import { PreAuthRateLimiter } from '../../../../src/core/http/pre-auth-rate-limiter.js';
import { throttleConfig } from '../../../../src/core/http/throttle.config.js';

type Rec = Awaited<ReturnType<ThrottlerStorage['increment']>>;
const record = (over: Partial<Rec>): Rec => ({
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...over,
});
const storageOf = (increment: ThrottlerStorage['increment']) => ({
  increment: vi.fn(increment),
});
const cfg = {
  limit: 300,
  ttlMs: 60000,
  preAuthLimit: 3,
  preAuthTtlMs: 30000,
};

async function rejectionOf(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof AppError)) throw new Error('expected an AppError');
  return err;
}

describe('PreAuthRateLimiter (S2-R51)', () => {
  it('counts per client IP under its own throttler with the same IP key as AppThrottlerGuard', async () => {
    const storage = storageOf(async () => record({}));
    await new PreAuthRateLimiter(storage, cfg).consume({ ip: '2001:db8::1' });
    expect(storage.increment).toHaveBeenCalledWith(
      `pre-auth:${clientIpTracker('2001:db8::1')}`,
      30000,
      3,
      30000,
      'pre-auth',
    );
    // IPv6 gom theo /64 như guard: cùng subnet, cùng khoá.
    expect(clientIpTracker('2001:db8::1')).toBe(
      clientIpTracker('2001:db8::ffff'),
    );
  });

  it('blocked → 429 rate_limited with Retry-After', async () => {
    const storage = storageOf(async () =>
      record({ isBlocked: true, timeToBlockExpire: 17 }),
    );
    const err = await rejectionOf(
      new PreAuthRateLimiter(storage, cfg).consume({ ip: '198.51.100.7' }),
    );
    expect([err.error.code, err.opts.headers]).toEqual([
      'rate_limited',
      { 'Retry-After': '17' },
    ]);
  });

  it('storage failure fails closed: 503 with Retry-After, never lets the request through', async () => {
    const storage = storageOf(async () => {
      throw new Error('redis and insurance both down');
    });
    const err = await rejectionOf(
      new PreAuthRateLimiter(storage, cfg).consume({ ip: '198.51.100.7' }),
    );
    expect([err.error.code, err.opts.headers]).toEqual([
      'service_unavailable',
      { 'Retry-After': '30' },
    ]);
  });

  it('an unresolved client IP is an error, not a shared bucket', async () => {
    const storage = storageOf(async () => record({}));
    await expect(
      new PreAuthRateLimiter(storage, cfg).consume({ ip: undefined }),
    ).rejects.toThrow('Cannot determine client IP for rate limiting');
    expect(storage.increment).not.toHaveBeenCalled();
  });
});

describe('throttle-pre-auth-not-looser production rule', () => {
  afterEach(() => vi.unstubAllEnvs());
  const check = () => {
    const r = productionRuleRegistry().find(
      (x) => x.name === 'throttle-pre-auth-not-looser',
    );
    if (!r) throw new Error('rule not registered');
    return r.rule({ throttle: throttleConfig() });
  };

  it('defaults pass; a pre-auth limit above the default route limit is rejected', () => {
    expect(check()).toBeUndefined();
    vi.stubEnv('THROTTLE_PRE_AUTH_LIMIT', '301');
    expect(check()).toBe(
      'THROTTLE_PRE_AUTH_LIMIT must be at most THROTTLE_DEFAULT_LIMIT in production',
    );
  });
});
