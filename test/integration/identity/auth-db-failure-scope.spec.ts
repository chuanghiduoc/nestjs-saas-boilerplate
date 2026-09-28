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
import { recordAuthApiError } from '../../../src/modules/identity/infra/better-auth/auth-db-failures.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { BetterAuthCoreModule } from '../../../src/modules/identity/infra/better-auth/better-auth-core.module.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const PASSWORD = 'correct horse battery';
/** `DB_AUTH_QUERY_TIMEOUT_MS` của ca "deadline phía client trên DB khoẻ": nhỏ hơn statement_timeout của role test (5000). */
const SHORT_QUERY_TIMEOUT_MS = 1000;
/** Ca hết chờ pool (review I2): hạn chờ connection ngắn, và lúc client bị giữ được nhả (sau hạn đó, trước khi probe hết chờ). */
const POOL_WAIT_MS = 300;
const RELEASE_AFTER_WAIT_MS = 100;
/** Ca đồng thời thật (review M3/M4): chờ connection đủ lâu để lời gọi thứ hai xếp hàng sau statement_timeout (5000) của lời gọi đầu. */
const LONG_POOL_WAIT_MS = 10_000;
const serverError = (code: string): pg.DatabaseError => {
  const e = new pg.DatabaseError('canceling statement', 0, 'error');
  e.code = code;
  return e;
};

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
  const spyError = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const spyWarn = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  let errors: ReturnType<typeof spyError> | undefined;
  let warns: ReturnType<typeof spyWarn> | undefined;
  /** Dòng log ERROR fail-loud của provider (review M7). */
  const providerFailures = () =>
    (errors?.mock.calls ?? []).flatMap(([fields]) =>
      typeof fields === 'object' &&
      fields !== null &&
      'event' in fields &&
      fields.event === 'auth_provider_failed'
        ? [fields]
        : [],
    );

  const start = async (env: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    app = await createTestApp(modules());
    owner = await ownerClient();
    errors = spyError();
    warns = spyWarn();
    const auth = app.get<AuthInstance>(BETTER_AUTH);
    return {
      auth,
      owner,
      pool: app.get<pg.Pool>(AUTH_POOL),
      provider: app.get(AuthProvider),
      cookie: await cookieOf(auth, owner),
    };
  };
  afterEach(async () => {
    errors?.mockRestore();
    warns?.mockRestore();
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

  it('M3/M4: two concurrent calls sharing ONE real pool client: the infra failure of the first never reaches the second, whose genuine storage error (42501) stays REJECTED', async () => {
    const t = await start({
      DB_AUTH_POOL_MAX: '1',
      DB_AUTH_CONNECTION_TIMEOUT_MS: String(LONG_POOL_WAIT_MS),
    });
    const { key } = await t.auth.api.createApiKey({
      body: { name: 'scope' },
      headers: new Headers({ cookie: t.cookie }),
    });
    await t.owner.query('REVOKE SELECT ON auth.apikey FROM auth_user');
    const release = await lockSessions(t.owner);
    try {
      // A giữ client DUY NHẤT của pool, chặn trên lock tới 57014 (statement_timeout 5000 ms của role test).
      const infra = t.provider.authenticate({
        headers: new Headers({ cookie: t.cookie }),
        credential: { kind: 'SESSION_COOKIE', value: 'x' },
      });
      await vi.waitFor(() => expect(t.pool.idleCount).toBe(0));
      // B xếp hàng trong pool, nhận ĐÚNG client đó sau khi A đã ghi lỗi, rồi gặp 42501 (không phải hạ tầng): verifyApiKey
      // nuốt thành INVALID_API_KEY mơ hồ, probe thấy DB khoẻ → REJECTED. Lỗi của A tràn sang B thì B thành UNAVAILABLE.
      const genuine = t.provider.authenticate({
        headers: new Headers(),
        credential: { kind: 'API_KEY', value: key },
      });
      await vi.waitFor(() => expect(t.pool.waitingCount).toBe(1));
      expect(await Promise.all([infra, genuine])).toEqual([
        { kind: 'UNAVAILABLE' },
        { kind: 'REJECTED' },
      ]);
    } finally {
      await release();
      await t.owner.query('GRANT SELECT ON auth.apikey TO auth_user');
    }
  });

  it('I2: a pool-wait timeout is recorded: the pool is exhausted, the checkout of Better Auth times out, and a probe that would now succeed still gives UNAVAILABLE, not a 500', async () => {
    const t = await start({
      DB_AUTH_POOL_MAX: '1',
      DB_AUTH_CONNECTION_TIMEOUT_MS: String(POOL_WAIT_MS),
    });
    const held = await t.pool.connect();
    let released = false;
    const releaseHeld = () => {
      if (released) return;
      released = true;
      held.release();
    };
    // Nhả client ngay SAU khi checkout của Better Auth đã hết chờ: nếu provider còn hỏi probe S2-R45, probe lấy được
    // client này, `SELECT` thành công, và 500 của getSession bị ném nguyên (bug trước khi ghi lỗi checkout).
    const timer = setTimeout(releaseHeld, POOL_WAIT_MS + RELEASE_AFTER_WAIT_MS);
    try {
      expect(
        await t.provider.authenticate({
          headers: new Headers({ cookie: t.cookie }),
          credential: { kind: 'SESSION_COOKIE', value: 'x' },
        }),
      ).toEqual({ kind: 'UNAVAILABLE' });
    } finally {
      clearTimeout(timer);
      releaseHeld();
    }
  });

  it('M1: a recorded infra failure never turns a clear programmer error into UNAVAILABLE; it is rethrown and logged at ERROR', async () => {
    const t = await start();
    const bug = new TypeError('bug after a recovered storage error');
    const spy = vi
      .spyOn(t.auth.api, 'getSession')
      .mockImplementationOnce(async () => {
        recordAuthApiError(serverError('57014'));
        throw bug;
      });
    try {
      await expect(
        t.provider.authenticate({
          headers: new Headers({ cookie: t.cookie }),
          credential: { kind: 'SESSION_COOKIE', value: 'x' },
        }),
      ).rejects.toBe(bug);
      expect(providerFailures()).toEqual([
        expect.objectContaining({ errorClass: 'TypeError' }),
      ]);
    } finally {
      spy.mockRestore();
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
      expect(providerFailures()).toEqual([
        expect.objectContaining({
          event: 'auth_provider_failed',
          errorClass: 'APIError',
          dbError: undefined,
        }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
