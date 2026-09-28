import { Logger, type INestApplication } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { BetterAuthCoreModule } from '../../../src/modules/identity/infra/better-auth/better-auth-core.module.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const PASSWORD = 'correct horse battery';
/** `DB_AUTH_QUERY_TIMEOUT_MS` của ca "deadline phía client trên DB khoẻ": nhỏ hơn statement_timeout của role test (5000). */
const SHORT_QUERY_TIMEOUT_MS = 1000;

const modules = () => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: false }),
  OutboxModule.forRoot({ relay: false }),
  EventsModule.forRoot({ worker: false }),
  NotificationsModule.forApi(),
  BetterAuthCoreModule,
];
const ownerClient = async () => {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await c.connect();
  return c;
};
const cookieOf = async (auth: AuthInstance, owner: pg.Client) => {
  const email = `scope-${v7()}@example.test`;
  await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: 'S' },
  });
  await owner.query(
    `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
    [email],
  );
  const res = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
};
/**
 * Giữ ACCESS EXCLUSIVE trên `auth.session` trong một session riêng (app_owner): DB vẫn khoẻ (probe `SELECT 1` qua
 * pool auth thành công), nhưng lookup session của Better Auth bị chặn tới khi bị huỷ.
 */
const lockSessions = async (owner: pg.Client) => {
  await owner.query('BEGIN');
  await owner.query('LOCK TABLE auth.session IN ACCESS EXCLUSIVE MODE');
  return async () => {
    await owner.query('ROLLBACK');
  };
};

/**
 * S2-R65: Better Auth `getSession` đổi lỗi DB thành `APIError(500, FAILED_TO_GET_SESSION)` và bỏ `cause`, probe S2-R45
 * thấy DB khoẻ, nên một query bị huỷ trên DB khoẻ (57014 do lock, hoặc `Query read timeout` của S2-R60) từng thành 500.
 * Lỗi hạ tầng của query được ghi theo từng lời gọi và biến 500 mơ hồ thành UNAVAILABLE (503).
 */
describe('S2-R65: an auth DB query cancelled while the DB is healthy is UNAVAILABLE, not a 500', () => {
  let app: INestApplication | undefined;
  let owner: pg.Client | undefined;
  let quiet: { mockRestore(): void }[] = [];

  const start = async (env: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    app = await createTestApp(modules());
    owner = await ownerClient();
    quiet = [
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    ];
    const auth = app.get<AuthInstance>(BETTER_AUTH);
    return {
      auth,
      owner,
      provider: app.get(AuthProvider),
      cookie: await cookieOf(auth, owner),
    };
  };
  afterEach(async () => {
    for (const s of quiet) s.mockRestore();
    await owner?.end();
    await app?.close();
    vi.unstubAllEnvs();
    app = undefined;
    owner = undefined;
  });

  it('57014 (statement_timeout while blocked on a lock): session lookup is UNAVAILABLE', async () => {
    const t = await start();
    const release = await lockSessions(t.owner);
    try {
      expect(
        await t.provider.authenticate({
          headers: new Headers({ cookie: t.cookie }),
          credential: { kind: 'SESSION_COOKIE', value: 'x' },
        }),
      ).toEqual({ kind: 'UNAVAILABLE' });
    } finally {
      await release();
    }
  });

  it('Query read timeout (S2-R60 client deadline) on a healthy DB: session lookup is UNAVAILABLE', async () => {
    const t = await start({
      DB_AUTH_QUERY_TIMEOUT_MS: String(SHORT_QUERY_TIMEOUT_MS),
    });
    const release = await lockSessions(t.owner);
    try {
      expect(
        await t.provider.authenticate({
          headers: new Headers({ cookie: t.cookie }),
          credential: { kind: 'SESSION_COOKIE', value: 'x' },
        }),
      ).toEqual({ kind: 'UNAVAILABLE' });
    } finally {
      await release();
    }
  });

  it('the recorded failure never leaks into a concurrent call: a genuine 500 in a parallel request is still rethrown', async () => {
    const t = await start({
      DB_AUTH_QUERY_TIMEOUT_MS: String(SHORT_QUERY_TIMEOUT_MS),
    });
    const original = t.auth.api.getSession.bind(t.auth.api);
    let infraDone: () => void = () => undefined;
    const infraSettled = new Promise<void>((resolve) => {
      infraDone = resolve;
    });
    const bug = new APIError('INTERNAL_SERVER_ERROR', {
      code: 'FAILED_TO_GET_SESSION',
    });
    // Lời gọi "bug" chỉ ném SAU KHI lời gọi hạ tầng đã ghi lỗi và kết thúc, trong khi scope của chính nó còn mở: một
    // trạng thái dùng chung (không theo từng lời gọi) sẽ biến 500 của nó thành UNAVAILABLE.
    const spy = vi
      .spyOn(t.auth.api, 'getSession')
      .mockImplementation((...args) =>
        new Headers(args[0]?.headers).get('x-case') === 'bug'
          ? infraSettled.then(() => {
              throw bug;
            })
          : original(...args),
      );
    const release = await lockSessions(t.owner);
    try {
      const infra = t.provider
        .authenticate({
          headers: new Headers({ cookie: t.cookie }),
          credential: { kind: 'SESSION_COOKIE', value: 'x' },
        })
        .finally(infraDone);
      const genuine = t.provider.authenticate({
        headers: new Headers({ 'x-case': 'bug' }),
        credential: { kind: 'BEARER_SESSION', value: 't' },
      });
      const [a, b] = await Promise.allSettled([infra, genuine]);
      expect(a).toEqual({
        status: 'fulfilled',
        value: { kind: 'UNAVAILABLE' },
      });
      expect(b).toEqual({ status: 'rejected', reason: bug });
    } finally {
      spy.mockRestore();
      await release();
    }
  });

  it('a genuine 500 with the DB healthy and no infra failure recorded is still rethrown (S2-R45 fail-loud)', async () => {
    const t = await start();
    const bug = new APIError('INTERNAL_SERVER_ERROR', {
      code: 'FAILED_TO_GET_SESSION',
    });
    const spy = vi.spyOn(t.auth.api, 'getSession').mockRejectedValueOnce(bug);
    try {
      await expect(
        t.provider.authenticate({
          headers: new Headers({ cookie: t.cookie }),
          credential: { kind: 'SESSION_COOKIE', value: 'x' },
        }),
      ).rejects.toBe(bug);
    } finally {
      spy.mockRestore();
    }
  });
});
