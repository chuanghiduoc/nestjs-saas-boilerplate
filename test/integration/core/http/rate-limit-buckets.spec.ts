import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimitBuckets } from '../../../../src/core/http/rate-limit-buckets.js';
import { RateLimiterThrottlerStorage } from '../../../../src/core/http/rate-limiter.storage.js';
import { getInfra } from '../../../support/infra.js';

const LIMIT = 3;
const TTL_MS = 60_000;

describe('RateLimitBuckets on Redis (spec SP3 §7.1 step 3.5, P-3)', () => {
  const ns = `t${randomBytes(4).toString('hex')}`;
  let redis: Redis;
  let buckets: RateLimitBuckets;
  beforeAll(() => {
    redis = new Redis(getInfra().redis.url, { maxRetriesPerRequest: 1 });
    buckets = new RateLimitBuckets(new RateLimiterThrottlerStorage(redis, ns));
  });
  afterAll(async () => {
    const keys = await redis.keys(`${ns}-*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('peek never spends a point, even under 2 x limit parallel calls; only consume counts and then blocks', async () => {
    const b = buckets.register({
      owner: 'tenancy',
      name: 'org-miss',
      ttlMs: TTL_MS,
      limit: LIMIT,
      refundable: false,
    });
    const decisions = await Promise.all(
      Array.from({ length: 2 * LIMIT }, () => b.peek('principal:user:a')),
    );
    expect(decisions.every((d) => !d.blocked)).toBe(true);
    for (let i = 0; i < LIMIT; i++)
      expect(await b.consume('principal:user:a')).toEqual({ blocked: false });
    // Hợp đồng `> limit` (review I4): đúng `limit` điểm đã tiêu thì `peek` CHƯA chặn; chỉ lần consume vượt ngưỡng mới chặn.
    expect(await b.peek('principal:user:a')).toEqual({ blocked: false });
    const over = await b.consume('principal:user:a');
    expect(over.blocked).toBe(true);
    const peeked = await b.peek('principal:user:a');
    expect(peeked.blocked).toBe(true);
    expect(peeked.blocked && peeked.retryAfterSec).toBeGreaterThan(0);
    expect(await b.peek('principal:user:b')).toEqual({ blocked: false });
  });
  it('two owners with the same name never share a counter', async () => {
    const x = buckets.register({
      owner: 'alpha',
      name: 'shared',
      ttlMs: TTL_MS,
      limit: 1,
      refundable: false,
    });
    const y = buckets.register({
      owner: 'beta',
      name: 'shared',
      ttlMs: TTL_MS,
      limit: 1,
      refundable: false,
    });
    await x.consume('k');
    await x.consume('k');
    expect((await x.peek('k')).blocked).toBe(true);
    expect((await y.peek('k')).blocked).toBe(false);
  });
});
