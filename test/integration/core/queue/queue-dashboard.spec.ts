import {
  Global,
  Injectable,
  Module,
  type INestApplication,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import { CoreErrors } from '../../../../src/core/errors/index.js';
import {
  QueueDashboardAuthorizer,
  QueueModule,
  type QueueDashboardDecision,
} from '../../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../../src/core/queue/dashboard/queue-dashboard.server.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

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

const env = (allow: string) => {
  vi.stubEnv('APP_ROLE', 'worker');
  vi.stubEnv('WORKER_QUEUES', 'maintenance');
  vi.stubEnv('QUEUE_DASHBOARD_ENABLED', 'true');
  vi.stubEnv('QUEUE_DASHBOARD_PORT', '0');
  vi.stubEnv('QUEUE_DASHBOARD_IP_ALLOWLIST', allow);
};
const base = (app: INestApplication) =>
  `http://127.0.0.1:${app.get(QueueDashboardServer).address().port}/queues`;

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
  });

  it('mutations are refused even for an authorized caller (read-only enforced by Bull Board)', async () => {
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
    expect(r.status).toBeGreaterThanOrEqual(400);
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

  it('enabled without an authorizer → the worker refuses to start', async () => {
    env('127.0.0.1/32');
    await expect(
      createTestApp([
        DatabaseModule.forRoot({ relay: true }),
        RedisModule,
        QueueModule.forRoot({ runWorkers: true }),
      ]),
    ).rejects.toThrow(/QueueDashboardAuthorizer/);
  });
});
