import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { vi } from 'vitest';
import { DatabaseModule } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { HealthModule } from '../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../src/core/http/index.js';
import { OutboxModule, OutboxRelay } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { IdentityModule } from '../../src/modules/identity/index.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import {
  buildTestApp,
  createTestApp,
  nestedIn,
  type ConfigureTestingModule,
  type ModuleImport,
} from './app-factory.js';
import { getInfra } from './infra.js';
import { seedStaffStepUp } from './seed-staff-step-up.js';

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
  // Mức sàn chống dò email theo thời gian (S2-R58) làm mỗi sign-up chậm 300 ms; spec về timing tự bật lại.
  AUTH_ENUMERATION_MIN_RESPONSE_MS: '0',
};

type IdentityAppOpts = {
  extraImports?: ModuleImport[];
  env?: Record<string, string>;
  /** Bọc `IdentityModule.forApi()` trong N module rỗng: đổi thứ tự middleware (xem `nestedIn`). */
  identityDepth?: number;
  configure?: ConfigureTestingModule;
};

const identityImports = (opts: IdentityAppOpts): ModuleImport[] => {
  for (const [k, v] of Object.entries({ ...IDENTITY_E2E_ENV, ...opts.env }))
    vi.stubEnv(k, v);
  return [
    DatabaseModule.forRoot({ relay: true }),
    RedisModule,
    QueueModule.forRoot({ runWorkers: true }),
    OutboxModule.forRoot({ relay: true }),
    EventsModule.forRoot({ worker: true }),
    HttpModule,
    HealthModule.forRoot({ http: true }),
    NotificationsModule.forWorker(),
    nestedIn(IdentityModule.forApi(), opts.identityDepth ?? 0),
    ...(opts.extraImports ?? []),
  ];
};

/**
 * Cùng app với `startIdentityApp` nhưng CHƯA `init()`: cho spec kiểm lỗi boot (`onModuleInit` ném) mà vẫn giữ handle
 * để `close()` đóng pool/Redis đã mở.
 */
export async function buildIdentityApp(
  opts: IdentityAppOpts = {},
): Promise<INestApplication> {
  const app = await buildTestApp(identityImports(opts), {
    bodyParser: false,
    configure: opts.configure,
  });
  applyHttpDefaults(app);
  return app;
}

export async function startIdentityApp(
  opts: IdentityAppOpts = {},
): Promise<INestApplication> {
  const app = await createTestApp(identityImports(opts), {
    beforeInit: applyHttpDefaults,
    bodyParser: false,
    configure: opts.configure,
  });
  // `APP_ROLE` giữ `api` (phía HTTP như production), nên `OutboxRelay` không tự chạy ở bootstrap (chỉ autostart
  // khi role `worker`): khởi động tay để event/thư thật sự rời outbox. `beforeApplicationShutdown` tự dừng nó
  // khi `app.close()`.
  app.get(OutboxRelay).start();
  return app;
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
/** Spec SP3 §5.3 (N5-1): admin của test SP2 dùng `/admin/*`/Bull Board/`/token` phải có dấu TOTP. Gọi SAU khi đăng nhập. */
export async function promoteToStaff(email: string): Promise<void> {
  await promoteToAdmin(email);
  await seedStaffStepUp({ email });
}
export const verifyEmailDirect = (email: string) =>
  ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [
    email,
  ]);
