import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { RateLimiterThrottlerStorage } from '../../../../src/core/http/rate-limiter.storage.js';
import { getInfra } from '../../../support/infra.js';

const WINDOW_MS = 60_000;
const LIMIT = 2;
const THROTTLER = 'default';

describe('RateLimiterThrottlerStorage (rate-limiter-flexible on ioredis)', () => {
  const ns = `t${randomBytes(4).toString('hex')}`;
  let redis: Redis;
  let storage: RateLimiterThrottlerStorage;
  const hit = (key: string) =>
    storage.increment(key, WINDOW_MS, LIMIT, WINDOW_MS, THROTTLER);

  beforeAll(() => {
    redis = new Redis(getInfra().redis.url, { maxRetriesPerRequest: 1 });
    storage = new RateLimiterThrottlerStorage(redis, ns);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    const keys = await redis.keys(`${ns}-*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('counts in Redis and reports ThrottlerStorageRecord times in seconds', async () => {
    const first = await hit('a');
    expect(first).toMatchObject({
      totalHits: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(first.timeToExpire).toBeGreaterThan(0);
    expect(first.timeToExpire).toBeLessThanOrEqual(WINDOW_MS / 1000);
    await hit('a');
    const blocked = await hit('a');
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.totalHits).toBe(LIMIT + 1);
    expect(blocked.timeToBlockExpire).toBeGreaterThan(0);
    expect(blocked.timeToBlockExpire).toBeLessThanOrEqual(WINDOW_MS / 1000);
    expect(await redis.keys(`${ns}-rl-*`)).not.toHaveLength(0);
  });

  it('refuses windows that are not whole seconds instead of rounding silently', async () => {
    await expect(
      storage.increment('b', 1500, LIMIT, 1500, THROTTLER),
    ).rejects.toThrow(/whole seconds/);
  });

  it('Redis down → in-memory insurance limiter still enforces the limit; fallback logged once per episode', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const log = vi.spyOn(Logger.prototype, 'log');
    const fallbackWarnings = () =>
      warn.mock.calls.filter((c) => String(c[1] ?? c[0]).includes('insurance'))
        .length;

    redis.disconnect();
    expect((await hit('down')).isBlocked).toBe(false);
    expect((await hit('down')).isBlocked).toBe(false);
    expect((await hit('down')).isBlocked).toBe(true);
    expect(fallbackWarnings()).toBe(1);

    await redis.connect();
    expect((await hit('up')).isBlocked).toBe(false);
    expect(
      log.mock.calls.filter((c) => String(c[1] ?? c[0]).includes('recovered')),
    ).toHaveLength(1);

    redis.disconnect();
    await hit('down-again');
    await hit('down-again');
    expect(fallbackWarnings()).toBe(2);
    await redis.connect();
  });
});
