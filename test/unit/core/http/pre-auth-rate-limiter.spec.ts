import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { AppError, CoreErrors } from '../../../../src/core/errors/index.js';
import {
  clientIpTracker,
  rateLimitKey,
} from '../../../../src/core/http/client-ip.js';
import { PreAuthRateLimiter } from '../../../../src/core/http/pre-auth-rate-limiter.js';
import { RateLimiterThrottlerStorage } from '../../../../src/core/http/rate-limiter.storage.js';
import { throttleConfig } from '../../../../src/core/http/throttle.config.js';

type Rec = Awaited<ReturnType<ThrottlerStorage['increment']>>;
const record = (over: Partial<Rec>): Rec => ({
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...over,
});
const cfg = {
  limit: 300,
  ttlMs: 60000,
  preAuthLimit: 3,
  preAuthTtlMs: 30000,
};
/** `lazyConnect`: không mở kết nối nào; mọi lời gọi storage trong spec này đều bị spy thay thế. */
const redis = new Redis({ lazyConnect: true });
const storage = new RateLimiterThrottlerStorage(redis, 'unit');
const limiter = () => new PreAuthRateLimiter(storage, cfg);

async function rejectionOf(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof AppError)) throw new Error('expected an AppError');
  return err;
}

describe('PreAuthRateLimiter (S2-R51, S2-R53)', () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => redis.disconnect());

  it('refuses a storage that cannot refund (fails at construction, no blind cast)', () => {
    const other: ThrottlerStorage = { increment: async () => record({}) };
    expect(() => new PreAuthRateLimiter(other, cfg)).toThrow(
      'PreAuthRateLimiter requires the RateLimiterThrottlerStorage of HttpModule',
    );
  });

  it('counts per client IP under its own throttler; the stored key is the sha256 of the shared IP tracker, never the raw IP', async () => {
    const increment = vi
      .spyOn(storage, 'increment')
      .mockResolvedValue(record({}));
    const refund = vi.spyOn(storage, 'refund').mockResolvedValue();
    await limiter().consume({ ip: '2001:db8::1' });
    await limiter().refund({ ip: '2001:db8::1' });
    const key = rateLimitKey('pre-auth', clientIpTracker('2001:db8::1'));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(increment).toHaveBeenCalledWith(key, 30000, 3, 30000, 'pre-auth');
    expect(refund).toHaveBeenCalledWith(key, 30000, 3, 30000, 'pre-auth');
    // IPv6 gom theo /64 như guard: cùng subnet, cùng khoá.
    expect(clientIpTracker('2001:db8::1')).toBe(
      clientIpTracker('2001:db8::ffff'),
    );
  });

  it('blocked → 429 rate_limited with Retry-After', async () => {
    vi.spyOn(storage, 'increment').mockResolvedValue(
      record({ isBlocked: true, timeToBlockExpire: 17 }),
    );
    const err = await rejectionOf(limiter().consume({ ip: '198.51.100.7' }));
    expect([err.error.code, err.opts.headers]).toEqual([
      'rate_limited',
      { 'Retry-After': '17' },
    ]);
  });

  it('storage down: the 503 of the storage reaches the caller (fail closed)', async () => {
    const down = new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
      headers: { 'Retry-After': '30' },
    });
    vi.spyOn(storage, 'increment').mockRejectedValue(down);
    await expect(limiter().consume({ ip: '198.51.100.7' })).rejects.toBe(down);
  });

  it('a failed refund is logged and swallowed: it only makes the limit stricter', async () => {
    vi.spyOn(storage, 'refund').mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await expect(
      limiter().refund({ ip: '198.51.100.7' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { event: 'pre_auth_refund_failed', errorClass: 'Error' },
      expect.any(String),
    );
  });

  it('an unresolved client IP is an error, not a shared bucket', async () => {
    const increment = vi.spyOn(storage, 'increment');
    await expect(limiter().consume({ ip: undefined })).rejects.toThrow(
      'Cannot determine client IP for rate limiting',
    );
    expect(increment).not.toHaveBeenCalled();
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

  it('defaults pass; a larger count or a shorter window than the route default is rejected', () => {
    expect(check()).toBeUndefined();
    vi.stubEnv('THROTTLE_PRE_AUTH_LIMIT', '301');
    expect(check()).toBe(
      'THROTTLE_PRE_AUTH_LIMIT must be at most THROTTLE_DEFAULT_LIMIT in production',
    );
    vi.unstubAllEnvs();
    vi.stubEnv('THROTTLE_PRE_AUTH_TTL_MS', '10000');
    expect(check()).toBe(
      'THROTTLE_PRE_AUTH_TTL_MS must be at least THROTTLE_DEFAULT_TTL_MS in production',
    );
  });
});
