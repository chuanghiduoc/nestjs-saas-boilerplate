import type { ThrottlerStorage } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientIpTracker,
  rateLimitKey,
} from '../../../../src/core/http/client-ip.js';
import { RateLimitBuckets } from '../../../../src/core/http/rate-limit-buckets.js';
import { RateLimiterThrottlerStorage } from '../../../../src/core/http/rate-limiter.storage.js';

type Rec = Awaited<ReturnType<ThrottlerStorage['increment']>>;
const record = (over: Partial<Rec>): Rec => ({
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...over,
});
const redis = new Redis({ lazyConnect: true });
const storage = new RateLimiterThrottlerStorage(redis, 'unit');
const def = { ttlMs: 60000, limit: 30 };

describe('RateLimitBuckets (spec SP3 §5.2, SEC2-N5)', () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => redis.disconnect());

  it('refuses a storage that is not the SP1 RateLimiterThrottlerStorage', () => {
    const other: ThrottlerStorage = { increment: async () => record({}) };
    expect(() => new RateLimitBuckets(other)).toThrow(
      'RateLimitBuckets requires the RateLimiterThrottlerStorage of HttpModule',
    );
  });
  it('names a bucket <owner>.<name>, refuses duplicates and malformed parts at registration', () => {
    const buckets = new RateLimitBuckets(storage);
    expect(
      buckets.register({
        owner: 'tenancy',
        name: 'org-miss',
        refundable: false,
        ...def,
      }).name,
    ).toBe('tenancy.org-miss');
    expect(() =>
      buckets.register({
        owner: 'tenancy',
        name: 'org-miss',
        refundable: false,
        ...def,
      }),
    ).toThrow('Rate limit bucket "tenancy.org-miss" is already registered');
    for (const bad of [
      { owner: 'Tenancy', name: 'x' },
      { owner: 'tenancy', name: 'a.b' },
      { owner: '', name: 'x' },
    ])
      expect(() =>
        buckets.register({ ...bad, refundable: false, ...def }),
      ).toThrow(/must match/);
    expect(() =>
      buckets.register({
        owner: 'core',
        name: 'z',
        refundable: false,
        ttlMs: 60000,
        limit: 0,
      }),
    ).toThrow(/limit/);
  });
  it('hashes the caller key under the bucket name and never exposes other buckets', async () => {
    const increment = vi
      .spyOn(storage, 'increment')
      .mockResolvedValue(record({}));
    const peek = vi
      .spyOn(storage, 'peek')
      .mockResolvedValue({ blocked: false });
    const b = new RateLimitBuckets(storage).register({
      owner: 'tenancy',
      name: 'org-miss',
      refundable: false,
      ...def,
    });
    const tracker = 'principal:user:u1';
    await b.peek(tracker);
    await b.consume(tracker);
    const key = rateLimitKey('tenancy.org-miss', tracker);
    expect(peek).toHaveBeenCalledWith(
      key,
      60000,
      30,
      60000,
      'tenancy.org-miss',
    );
    expect(increment).toHaveBeenCalledWith(
      key,
      60000,
      30,
      60000,
      'tenancy.org-miss',
    );
    expect('refund' in b).toBe(false);
  });
  it('consume reports a block instead of throwing; the caller decides the response', async () => {
    vi.spyOn(storage, 'increment').mockResolvedValue(
      record({ isBlocked: true, timeToBlockExpire: 42 }),
    );
    const b = new RateLimitBuckets(storage).register({
      owner: 'core',
      name: 'x',
      refundable: true,
      ...def,
    });
    await expect(b.consume(clientIpTracker('198.51.100.9'))).resolves.toEqual({
      blocked: true,
      retryAfterSec: 42,
    });
  });
});
