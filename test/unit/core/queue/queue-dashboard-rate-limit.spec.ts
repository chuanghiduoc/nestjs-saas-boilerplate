import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { errorsConfig } from '../../../../src/core/errors/index.js';
import { redisConfig } from '../../../../src/core/redis/index.js';
import { queueDashboardConfig } from '../../../../src/core/queue/dashboard/queue-dashboard.config.js';
import { QueueDashboardServer } from '../../../../src/core/queue/dashboard/queue-dashboard.server.js';

/** The board has no registered queue in a unit test, so it never opens a Redis connection. */
const UNUSED_REDIS_URL = 'redis://127.0.0.1:1';
const LIMIT = 2;
const WINDOW_MS = 60_000;
const WINDOW_SEC = WINDOW_MS / 1000;
/** An allowlist that does not contain the loopback client of the test. */
const OTHER_HOST = '10.0.0.1';
const PATH = '/queues/api/queues';

let dashboard: QueueDashboardServer | undefined;
afterEach(async () => dashboard?.beforeApplicationShutdown());

async function board(ipAllowlist: string) {
  let authorizeCalls = 0;
  dashboard = new QueueDashboardServer(
    queueDashboardConfig.schema.parse({
      enabled: 'true',
      port: 0,
      ipAllowlist,
      rateLimit: String(LIMIT),
      rateLimitTtlMs: String(WINDOW_MS),
    }),
    redisConfig.schema.parse({ url: UNUSED_REDIS_URL }),
    'test-dashboard',
    errorsConfig.schema.parse({}),
    {
      authorize: async () => {
        authorizeCalls++;
        return { allowed: true };
      },
    },
  );
  await dashboard.onApplicationBootstrap();
  return {
    client: request(`http://127.0.0.1:${dashboard.address().port}`),
    authorizeCalls: () => authorizeCalls,
  };
}

describe('dashboard rate limit', () => {
  it('answers 429 rate_limited with Retry-After once an allowlisted IP passes the limit, before the authorizer runs', async () => {
    const b = await board('127.0.0.1');
    for (let i = 0; i < LIMIT; i++) await b.client.get(PATH).expect(200);
    const res = await b.client.get(PATH).expect(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      code: 'rate_limited',
      status: 429,
      instance: PATH,
    });
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(WINDOW_SEC);
    expect(b.authorizeCalls()).toBe(LIMIT);
  });

  it('checks the allowlist first: a denied IP keeps getting 403 and never reaches the limiter or the authorizer', async () => {
    const b = await board(OTHER_HOST);
    for (let i = 0; i < LIMIT * 2; i++) await b.client.get(PATH).expect(403);
    expect(b.authorizeCalls()).toBe(0);
  });
});
