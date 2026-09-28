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
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { AppError } from '../../../../src/core/errors/index.js';
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

  it('refund gives back exactly one point atomically (S2-R53)', async () => {
    await hit('r');
    await storage.refund('r', WINDOW_MS, LIMIT, WINDOW_MS, THROTTLER);
    await hit('r');
    expect((await hit('r')).isBlocked).toBe(false);
    expect((await hit('r')).isBlocked).toBe(true);
  });

  it('Redis AND insurance failing is a fail-closed 503 with Retry-After, not a 500 (S2-R53 N4)', async () => {
    vi.spyOn(RateLimiterRedis.prototype, 'consume').mockRejectedValue(
      new Error('store and insurance both failed'),
    );
    const err = await storage
      .increment('both-down', WINDOW_MS, LIMIT, WINDOW_MS, THROTTLER)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AppError);
    if (!(err instanceof AppError)) return;
    expect([err.error.code, err.opts.headers]).toEqual([
      'service_unavailable',
      { 'Retry-After': String(WINDOW_MS / 1000) },
    ]);
  });

  it('peek: Redis down is served by insurance without spending a point; Redis AND insurance failing is a fail-closed 503 (spec SP3 §5.2)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');
    const peek = () =>
      storage.peek('peek-down', WINDOW_MS, LIMIT, WINDOW_MS, THROTTLER);
    try {
      redis.disconnect();
      // Redis lỗi thật → `_handleError` của rate-limiter-flexible chuyển sang `insuranceLimiter.get`.
      expect(await peek()).toEqual({ blocked: false });
      // Hợp đồng JSDoc của `peek`: insurance phục vụ `peek` không log cảnh báo đợt sự cố (chỉ `consume` báo).
      expect(
        warn.mock.calls.filter((c) =>
          String(c[1] ?? c[0]).includes('insurance'),
        ),
      ).toHaveLength(0);
      // Insurance cũng lỗi → nhánh `unavailable` thật của storage.
      vi.spyOn(RateLimiterMemory.prototype, 'get').mockRejectedValue(
        new Error('insurance failed'),
      );
      const err = await peek().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      if (!(err instanceof AppError)) return;
      expect([err.error.code, err.opts.headers]).toEqual([
        'service_unavailable',
        { 'Retry-After': String(WINDOW_MS / 1000) },
      ]);
      expect(error).toHaveBeenCalledWith(
        { namespace: ns, errorClass: 'Error' },
        'rate limit storage failed (redis and insurance); refusing the request',
      );
    } finally {
      if (redis.status !== 'ready') await redis.connect();
    }
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

    // Luôn nối lại trong finally: assertion fail giữa chừng không được để client đóng (afterAll cần dọn key).
    const reconnect = async () => {
      if (redis.status !== 'ready') await redis.connect();
    };
    try {
      redis.disconnect();
      expect((await hit('down')).isBlocked).toBe(false);
      expect((await hit('down')).isBlocked).toBe(false);
      expect((await hit('down')).isBlocked).toBe(true);
      expect(fallbackWarnings()).toBe(1);
    } finally {
      await reconnect();
    }
    expect((await hit('up')).isBlocked).toBe(false);
    expect(
      log.mock.calls.filter((c) => String(c[1] ?? c[0]).includes('recovered')),
    ).toHaveLength(1);

    try {
      redis.disconnect();
      await hit('down-again');
      await hit('down-again');
      expect(fallbackWarnings()).toBe(2);
    } finally {
      await reconnect();
    }
  });
});
