import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { vi } from 'vitest';
import { DatabaseModule } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { HealthModule } from '../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../src/core/http/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { IdentityModule } from '../../src/modules/identity/index.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import { createTestApp, type ModuleImport } from './app-factory.js';
import { getInfra } from './infra.js';

/**
 * App e2e "api + worker" trong một process: route HTTP thật + relay outbox + worker của queue `events` và
 * `notifications`, để thư thật sự tới Mailpit. Queue `maintenance` không được consume (cron test riêng).
 *
 * `AuthClient` (Task 36) gửi `x-forwarded-for` ngẫu nhiên theo client; `loopback` cho app tin header đó, nên
 * rate limit IP của Better Auth tính theo client chứ không gộp mọi test vào 127.0.0.1. Ngưỡng cao để các file
 * e2e không giẫm nhau; test về rate limit tự đặt ngưỡng thấp qua `opts.env`.
 */
const IDENTITY_E2E_ENV: Record<string, string> = {
  WORKER_QUEUES: 'events,notifications',
  HTTP_TRUST_PROXY: 'loopback',
  AUTH_RATE_LIMIT_MAX: '10000',
  AUTH_SIGNIN_RATE_MAX: '1000',
  AUTH_EMAIL_RATE_MAX: '1000',
  AUTH_TWO_FACTOR_RATE_MAX: '1000',
};

export async function startIdentityApp(
  opts: { extraImports?: ModuleImport[]; env?: Record<string, string> } = {},
): Promise<INestApplication> {
  for (const [k, v] of Object.entries({ ...IDENTITY_E2E_ENV, ...opts.env }))
    vi.stubEnv(k, v);
  return createTestApp(
    [
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }),
      HttpModule,
      HealthModule.forRoot({ http: true }),
      NotificationsModule.forWorker(),
      IdentityModule.forApi(),
      ...(opts.extraImports ?? []),
    ],
    { beforeInit: applyHttpDefaults, bodyParser: false },
  );
}

export async function ownerQuery<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}
export const promoteToAdmin = (email: string) =>
  ownerQuery(`UPDATE auth."user" SET role = 'admin' WHERE email = $1`, [email]);
export const verifyEmailDirect = (email: string) =>
  ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [
    email,
  ]);
