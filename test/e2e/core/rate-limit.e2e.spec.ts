import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HttpModule,
  SkipRateLimit,
  applyHttpDefaults,
} from '../../../src/core/http/index.js';
import {
  REDIS,
  REDIS_NAMESPACE,
  RedisModule,
} from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { TestPrincipalModule } from '../../support/test-principal.middleware.js';

const LIMIT = 5;
const WINDOW_SEC = 60;
const ORG_A = '0199aaaa-0000-7000-8000-00000000000a';
const ORG_B = '0199bbbb-0000-7000-8000-00000000000b';

@Controller('ping')
class P {
  @Get() ping() {
    return { ok: true };
  }
  @Get('free') @SkipRateLimit() free() {
    return { ok: true };
  }
}
@Module({ controllers: [P] })
class M {}

type Who = { principal?: string; org?: string; forwardedFor?: string };

describe('rate limit (@nestjs/throttler + rate-limiter-flexible)', () => {
  let a1: INestApplication;
  let a2: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', String(LIMIT));
    vi.stubEnv('THROTTLE_DEFAULT_TTL_MS', String(WINDOW_SEC * 1000));
    // Supertest đến từ loopback; tin loopback để req.ip lấy từ X-Forwarded-For như sau ingress.
    vi.stubEnv('HTTP_TRUST_PROXY', 'loopback');
    const imports = () => [RedisModule, HttpModule, TestPrincipalModule, M];
    a1 = await createTestApp(imports(), { beforeInit: applyHttpDefaults });
    a2 = await createTestApp(imports(), { beforeInit: applyHttpDefaults });
  });
  afterAll(async () => {
    const redis = a1.get<Redis>(REDIS);
    const keys = await redis.keys(`${a1.get<string>(REDIS_NAMESPACE)}-*`);
    if (keys.length) await redis.del(...keys);
    await a1.close();
    await a2.close();
    vi.unstubAllEnvs();
  });

  const get = (app: INestApplication, path: string, who: Who = {}) => {
    const r = request(app.getHttpServer()).get(path);
    if (who.principal) r.set('x-test-principal', who.principal);
    if (who.org) r.set('x-test-org', who.org);
    if (who.forwardedFor) r.set('x-forwarded-for', who.forwardedFor);
    return r;
  };
  const exhaust = async (who: Who) => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i++)
      statuses.push((await get(i % 2 ? a2 : a1, '/ping', who)).status);
    return statuses;
  };

  it('limit is shared across instances through Redis; 429 rate_limited problem+json with Retry-After', async () => {
    expect(await exhaust({ principal: 'user:heavy' })).toEqual(
      Array(LIMIT).fill(200),
    );
    const blocked = await get(a1, '/ping', { principal: 'user:heavy' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(blocked.body).toMatchObject({ code: 'rate_limited', status: 429 });
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(WINDOW_SEC);
  });

  it('sets X-RateLimit-Limit/Remaining/Reset on allowed responses', async () => {
    const res = await get(a1, '/ping', { principal: 'user:headers' }).expect(
      200,
    );
    expect(res.headers['x-ratelimit-limit']).toBe(String(LIMIT));
    expect(res.headers['x-ratelimit-remaining']).toBe(String(LIMIT - 1));
    const reset = Number(res.headers['x-ratelimit-reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(WINDOW_SEC);
  });

  it('tracks by principal: another principal behind the same IP is not blocked', async () => {
    expect((await get(a1, '/ping', { principal: 'user:light' })).status).toBe(
      200,
    );
  });

  it('tracks by principal and org: the same principal in another org has its own bucket', async () => {
    expect(await exhaust({ principal: 'user:multi', org: ORG_A })).toEqual(
      Array(LIMIT).fill(200),
    );
    expect(
      (await get(a1, '/ping', { principal: 'user:multi', org: ORG_A })).status,
    ).toBe(429);
    expect(
      (await get(a1, '/ping', { principal: 'user:multi', org: ORG_B })).status,
    ).toBe(200);
  });

  it('anonymous callers are tracked by client IP (req.ip under HTTP_TRUST_PROXY)', async () => {
    expect(await exhaust({ forwardedFor: '203.0.113.10' })).toEqual(
      Array(LIMIT).fill(200),
    );
    expect(
      (await get(a1, '/ping', { forwardedFor: '203.0.113.10' })).status,
    ).toBe(429);
    expect(
      (await get(a1, '/ping', { forwardedFor: '203.0.113.11' })).status,
    ).toBe(200);
  });

  it('SkipRateLimit routes are never limited', async () => {
    for (let i = 0; i < LIMIT * 2; i++)
      expect(
        (await get(a1, '/ping/free', { principal: 'user:heavy' })).status,
      ).toBe(200);
  });
});
