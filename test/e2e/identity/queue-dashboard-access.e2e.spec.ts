import type { INestApplication } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../src/core/queue/dashboard/queue-dashboard.server.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { IdentityModule } from '../../../src/modules/identity/index.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
describe('Bull Board access (spec §5.12)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  let url = '';
  const session = async (role?: string) => {
    const email = `q-${v7()}@example.test`;
    await auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Q' },
    });
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = true, role = coalesce($2, role) WHERE email = $1`,
      [email, role ?? null],
    );
    const r = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    return {
      cookie: r.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
      bearer: r.headers.get('set-auth-token') ?? '',
    };
  };
  const get = (headers: Record<string, string>) =>
    fetch(`${url}/api/queues`, { headers });
  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      APP_ROLE: 'worker',
      WORKER_QUEUES: 'events,notifications',
      QUEUE_DASHBOARD_ENABLED: 'true',
      QUEUE_DASHBOARD_PORT: '0',
      QUEUE_DASHBOARD_IP_ALLOWLIST: '127.0.0.1/32',
      AUTH_COOKIE_PREFIX: 'svc',
    }))
      vi.stubEnv(k, v);
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }),
      NotificationsModule.forWorker(),
      IdentityModule.forWorker(),
    ]);
    auth = app.get(BETTER_AUTH);
    url = `http://127.0.0.1:${app.get(QueueDashboardServer).address().port}/queues`;
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('no credential → 401; ordinary user → 403; platform admin (cookie) → 200', async () => {
    expect((await get({})).status).toBe(401);
    expect((await get({ cookie: (await session()).cookie })).status).toBe(403);
    expect(
      (await get({ cookie: (await session('admin')).cookie })).status,
    ).toBe(200);
  });
  it('an API key, even of an admin, → 403', async () => {
    const admin = await session('admin');
    const key = await auth.api.createApiKey({
      body: { name: 'k' },
      headers: new Headers({ cookie: admin.cookie }),
    });
    expect((await get({ 'x-api-key': key.key })).status).toBe(403);
  });
  it('duplicate credentials → 400; a cross-site mutation with the admin cookie → 403 origin_not_allowed', async () => {
    const admin = await session('admin');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${url}/api/queues`);
      const req = httpRequest({
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: [
          'cookie',
          admin.cookie,
          'authorization',
          `Bearer ${admin.bearer}`,
        ],
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    const m = await fetch(`${url}/api/queues/notifications/pause`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, origin: 'https://evil.test' },
    });
    expect(m.status).toBe(403);
  });
  it('a pending 2FA sign-in (two_factor cookie only) cannot open the dashboard', async () => {
    expect((await get({ cookie: 'svc.two_factor=forged' })).status).toBe(401);
  });
});
