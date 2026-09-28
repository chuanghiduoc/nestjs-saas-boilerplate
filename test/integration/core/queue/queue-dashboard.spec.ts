import {
  Global,
  Injectable,
  Module,
  type INestApplication,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../../src/core/config/index.js';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import { CoreErrors } from '../../../../src/core/errors/index.js';
import {
  QueueDashboardAuthorizer,
  QueueModule,
  type QueueDashboardDecision,
} from '../../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../../src/core/queue/dashboard/queue-dashboard.server.js';
import {
  RedisModule,
  redisClientOptions,
  redisConfig,
  redisNamespace,
} from '../../../../src/core/redis/index.js';
import { applyTestEnv, createTestApp } from '../../../support/app-factory.js';

@Injectable()
class HeaderAuthorizer extends QueueDashboardAuthorizer {
  async authorize(req: IncomingMessage): Promise<QueueDashboardDecision> {
    return req.headers['x-test-allow'] === 'yes'
      ? { allowed: true }
      : { allowed: false, error: CoreErrors.FORBIDDEN };
  }
}
@Global()
@Module({
  providers: [
    { provide: QueueDashboardAuthorizer, useClass: HeaderAuthorizer },
  ],
  exports: [QueueDashboardAuthorizer],
})
class AuthorizerModule {}

/** Luôn từ chối, nhưng kèm headers phải được chuyển tiếp (M1: headers trong decision của authorizer). */
const RETRY_AFTER_SECONDS = '30';
@Injectable()
class RetryAfterAuthorizer extends QueueDashboardAuthorizer {
  async authorize(): Promise<QueueDashboardDecision> {
    return {
      allowed: false,
      error: CoreErrors.FORBIDDEN,
      headers: { 'Retry-After': RETRY_AFTER_SECONDS },
    };
  }
}
@Global()
@Module({
  providers: [
    { provide: QueueDashboardAuthorizer, useClass: RetryAfterAuthorizer },
  ],
  exports: [QueueDashboardAuthorizer],
})
class RetryAfterAuthorizerModule {}

const env = (allow: string) => {
  vi.stubEnv('APP_ROLE', 'worker');
  vi.stubEnv('WORKER_QUEUES', 'maintenance');
  vi.stubEnv('QUEUE_DASHBOARD_ENABLED', 'true');
  vi.stubEnv('QUEUE_DASHBOARD_PORT', '0');
  vi.stubEnv('QUEUE_DASHBOARD_IP_ALLOWLIST', allow);
};
const base = (app: INestApplication) =>
  `http://127.0.0.1:${app.get(QueueDashboardServer).address().port}/queues`;

/**
 * Queue BullMQ thô, cùng connection/namespace với app (đọc qua config trực tiếp như
 * `redis-client-options.spec.ts`), để quan sát trạng thái job/queue độc lập với dashboard.
 * Luôn đóng trong `finally` của caller.
 */
function probeMaintenanceQueue(): Queue {
  applyTestEnv();
  const namespace = redisNamespace(redisConfig(), appConfig());
  return new Queue('maintenance', {
    connection: {
      url: redisConfig().url,
      ...redisClientOptions(redisConfig(), false),
    },
    prefix: namespace,
  });
}

describe('QueueDashboardServer', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it('allowlisted + authorized → 200; not authorized → the authorizer error as problem+json', async () => {
    env('127.0.0.1/32');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      AuthorizerModule,
    ]);
    expect(
      (
        await fetch(`${base(app)}/api/queues`, {
          headers: { 'x-test-allow': 'yes' },
        })
      ).status,
    ).toBe(200);
    const denied = await fetch(`${base(app)}/api/queues`);
    expect([denied.status, denied.headers.get('content-type')]).toEqual([
      403,
      expect.stringContaining('application/problem+json'),
    ]);
    // M4: `instance` includes the base path (Express strips it from `req.url` when the guard is
    // mounted at `basePath`, so it must read `originalUrl`); `requestId` is a real per-request
    // UUIDv7, never a constant, so a denial log line correlates with its response.
    const body: { instance: string; requestId: string } = await denied.json();
    expect(body.instance).toBe('/queues/api/queues');
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('mutations are refused with exactly 405, and the queue state is untouched (read-only enforced by Bull Board)', async () => {
    env('127.0.0.1/32');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      AuthorizerModule,
    ]);
    const r = await fetch(`${base(app)}/api/queues/maintenance/pause`, {
      method: 'PUT',
      headers: { 'x-test-allow': 'yes' },
    });
    expect(r.status).toBe(405);
    // Board-wide pause/resume: Bull Board itself answers 200 (a no-op over read-only queues); the
    // guard refuses them with the same 405 problem so the read-only surface is uniform.
    for (const action of ['pause', 'resume']) {
      const boardWide = await fetch(`${base(app)}/api/queues/${action}`, {
        method: 'PUT',
        headers: { 'x-test-allow': 'yes' },
      });
      expect([
        boardWide.status,
        boardWide.headers.get('content-type'),
        boardWide.headers.get('allow'),
      ]).toEqual([
        405,
        expect.stringContaining('application/problem+json'),
        'GET, HEAD',
      ]);
    }
    const probe = probeMaintenanceQueue();
    try {
      expect(await probe.isPaused()).toBe(false);
    } finally {
      await probe.close();
    }
  });

  it('a caller outside the IP allowlist → 403 before the authorizer runs', async () => {
    env('10.0.0.0/8');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      AuthorizerModule,
    ]);
    expect(
      (
        await fetch(`${base(app)}/api/queues`, {
          headers: { 'x-test-allow': 'yes' },
        })
      ).status,
    ).toBe(403);
  });

  it('the UI entry page and its static assets are guarded by the same IP allowlist + authorizer', async () => {
    env('127.0.0.1/32');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      AuthorizerModule,
    ]);
    const entry = await fetch(`${base(app)}/`, {
      headers: { 'x-test-allow': 'yes' },
    });
    expect(entry.status).toBe(200);
    const asset = await fetch(`${base(app)}/static/favicon.ico`, {
      headers: { 'x-test-allow': 'yes' },
    });
    expect(asset.status).toBe(200);
    // Unauthorized (no header) must be denied on both, even though Bull Board itself has no
    // notion of auth for the entry page or its assets — the guard runs in front of everything.
    expect((await fetch(`${base(app)}/`)).status).toBe(403);
    expect((await fetch(`${base(app)}/static/favicon.ico`)).status).toBe(403);
  });

  it('a caller outside the IP allowlist is denied the UI entry page and its static assets too', async () => {
    env('10.0.0.0/8');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      AuthorizerModule,
    ]);
    expect(
      (await fetch(`${base(app)}/`, { headers: { 'x-test-allow': 'yes' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base(app)}/static/favicon.ico`, {
          headers: { 'x-test-allow': 'yes' },
        })
      ).status,
    ).toBe(403);
  });

  it('forwards headers from the authorizer decision onto the denial response', async () => {
    env('127.0.0.1/32');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      RetryAfterAuthorizerModule,
    ]);
    const res = await fetch(`${base(app)}/api/queues`);
    expect(res.status).toBe(403);
    expect(res.headers.get('retry-after')).toBe(RETRY_AFTER_SECONDS);
  });

  it('closes the dashboard port after app.close() (shutdown)', async () => {
    env('127.0.0.1/32');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      AuthorizerModule,
    ]);
    const url = base(app);
    await app.close();
    app = undefined;
    await expect(fetch(`${url}/api/queues`)).rejects.toThrow();
  });

  it('enabled without an authorizer → the worker refuses to start, before any job is consumed or stalled', async () => {
    env('127.0.0.1/32');
    const probe = probeMaintenanceQueue();
    try {
      await probe.waitUntilReady();
      await probe.add('probe', { v: 1, p: {}, meta: {} });
      await expect(
        createTestApp([
          DatabaseModule.forRoot({ relay: true }),
          RedisModule,
          QueueModule.forRoot({ runWorkers: true }),
        ]),
      ).rejects.toThrow(/QueueDashboardAuthorizer/);
      const counts = await probe.getJobCounts(
        'waiting',
        'active',
        'failed',
        'delayed',
      );
      expect(counts).toMatchObject({
        waiting: 1,
        active: 0,
        failed: 0,
        delayed: 0,
      });
    } finally {
      await probe.obliterate({ force: true }).catch(() => {});
      await probe.close();
    }
  });
});
