import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { errorsConfig, CoreErrors } from '../../../../src/core/errors/index.js';
import { redisConfig } from '../../../../src/core/redis/index.js';
import { queueDashboardConfig } from '../../../../src/core/queue/dashboard/queue-dashboard.config.js';
import { QueueDashboardServer } from '../../../../src/core/queue/dashboard/queue-dashboard.server.js';
import type { QueueDashboardDecision } from '../../../../src/core/queue/dashboard/queue-dashboard.authorizer.js';

/** The board has no registered queue in a unit test, so it never opens a Redis connection. */
const UNUSED_REDIS_URL = 'redis://127.0.0.1:1';
let dashboard: QueueDashboardServer | undefined;
afterEach(async () => dashboard?.beforeApplicationShutdown());
async function board(decision: QueueDashboardDecision = { allowed: true }) {
  dashboard = new QueueDashboardServer(
    queueDashboardConfig.schema.parse({
      enabled: 'true',
      port: 0,
      ipAllowlist: '127.0.0.1',
    }),
    redisConfig.schema.parse({ url: UNUSED_REDIS_URL }),
    'test-dashboard',
    errorsConfig.schema.parse({}),
    { authorize: async () => decision },
  );
  await dashboard.onApplicationBootstrap();
  return request(`http://127.0.0.1:${dashboard.address().port}`);
}

describe('dashboard write guard', () => {
  it.each(['pause', 'resume'])(
    'rejects board-wide %s using the per-queue problem shape',
    async (action) => {
      const client = await board();
      for (const path of [
        `/queues/api/queues/${action}`,
        `/queues/api/queues/example/${action}`,
      ]) {
        const res = await client.put(path).expect(405);
        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(res.body).toMatchObject({
          code: 'method_not_allowed',
          status: 405,
          instance: path,
        });
      }
    },
  );
  it('rejects all other write methods before routing or parsing payloads', async () => {
    const client = await board();
    for (const method of ['post', 'patch', 'delete'] as const)
      await client[method]('/queues/api/queues')
        .send('invalid-json')
        .expect(405);
    await client.get('/queues/api/queues').expect(200);
    await client.head('/queues/api/queues').expect(200);
  });
  it('preserves authorization denials before the write guard', async () => {
    const client = await board({ allowed: false, error: CoreErrors.FORBIDDEN });
    await client.put('/queues/api/queues/pause').expect(403);
  });
});
