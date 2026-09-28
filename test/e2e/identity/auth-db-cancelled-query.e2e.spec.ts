import { Logger, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import request, { type Response } from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import {
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';
import { getInfra } from '../../support/infra.js';

const PASSWORD = 'correct horse battery';
/** Hạn của token đặt lại mật khẩu gieo thẳng vào `auth.verification` (ca I1). */
const RESET_TOKEN_TTL = '1 hour';

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
const expectStatus = (label: string, r: Response, status: number) =>
  expect([r.status, r.body?.code], label).toEqual([
    status,
    status === 503 ? 'service_unavailable' : 'internal_error',
  ]);

/** Các dòng log ERROR mang `event` cho trước (lời gọi `Logger#error(fields, message)`). */
const loggedEvents = (
  calls: readonly (readonly unknown[])[],
  event: string,
): unknown[] =>
  calls.flatMap(([fields]) =>
    typeof fields === 'object' &&
    fields !== null &&
    'event' in fields &&
    fields.event === event
      ? [fields]
      : [],
  );

/**
 * S2-R65 qua HTTP thật (mount `/api/auth/*` và route Nest `/v1/me`). DB auth KHOẺ (`/health/ready` 200, probe S2-R45
 * thành công) nhưng lookup session bị huỷ: `auth.session` bị khoá ACCESS EXCLUSIVE trong một session khác cho tới khi
 * `statement_timeout` của role `auth_user` (5000 ms ở DB test, nhỏ hơn `DB_AUTH_QUERY_TIMEOUT_MS` mặc định) huỷ
 * câu lệnh với 57014 — đúng ca của debug report Task 42 fix round 1, trước đây trả 500 `internal_error`.
 */
describe('S2-R65: auth DB query cancelled on a healthy DB → 503 on the mount and on Nest routes', () => {
  let app: INestApplication;
  let base = '';
  let owner: pg.Client;
  let c: AuthClient;
  let apiKey = '';
  const spyError = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const spyWarn = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  // Review M7: các ca lỗi cố ý in ERROR/WARN (filter, mount, provider); im lặng, và test 42501 kiểm nội dung của chúng.
  let errors: ReturnType<typeof spyError> | undefined;
  let warns: ReturnType<typeof spyWarn> | undefined;

  beforeAll(async () => {
    app = await startIdentityApp();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    owner = await ownerClient();
    c = new AuthClient(base);
    const email = `cq-${v7()}@example.test`;
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    await verifyEmailDirect(email);
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    apiKey = (
      await c.request('post', '/api/auth/api-key/create', {
        body: { name: 'cq' },
      })
    ).body.key;
    expect(apiKey).toBeTruthy();
    errors = spyError();
    warns = spyWarn();
  });
  afterAll(async () => {
    errors?.mockRestore();
    warns?.mockRestore();
    await owner?.end();
    await app?.close();
  });

  it('57014 while the DB is healthy: cookie /v1/me, get-session, and the session-required list-sessions (S2-R69, was 401) answer 503; the DB stays usable in the same window', async () => {
    await owner.query('BEGIN');
    await owner.query('LOCK TABLE auth.session IN ACCESS EXCLUSIVE MODE');
    try {
      const [me, session, sessions, keyed, ready] = await Promise.all([
        c.request('get', '/v1/me'),
        c.request('get', '/api/auth/get-session'),
        c.request('get', '/api/auth/list-sessions'),
        new AuthClient(base).request('get', '/v1/me', {
          cookie: false,
          apiKey,
        }),
        request(base).get('/health/ready'),
      ]);
      expectStatus('/v1/me (cookie)', me, 503);
      expect(Number(me.headers['retry-after'])).toBeGreaterThan(0);
      expectStatus('/api/auth/get-session', session, 503);
      expect(Number(session.headers['retry-after'])).toBeGreaterThan(0);
      // S2-R69: Better Auth nuốt lỗi lookup thành session `null` → 401; lỗi đã ghi biến nó thành 503, và 503 không
      // mang `Set-Cookie` nào (không bao giờ đăng xuất client vì lỗi DB).
      expectStatus('/api/auth/list-sessions', sessions, 503);
      expect(sessions.headers['set-cookie']).toBeUndefined();
      // DB thật sự khoẻ trong cùng cửa sổ: một request không chạm bảng bị khoá vẫn 200 và readiness 200. (Không phải
      // bằng chứng chống rò lỗi giữa request: lỗi đã ghi chỉ được đọc trên đường lỗi — xem ca đồng thời thật ở
      // test/integration/identity/auth-db-failure-scope.spec.ts.)
      expect(keyed.status, '/v1/me (api key)').toBe(200);
      expect(ready.status, '/health/ready').toBe(200);
    } finally {
      await owner.query('ROLLBACK');
    }
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    expect((await c.request('get', '/api/auth/get-session')).status).toBe(200);
    expect((await c.request('get', '/api/auth/list-sessions')).status).toBe(
      200,
    );
  });

  it('I1: a query of our OWN hook on the auth pool (reset-password reclaim, FOR UPDATE on auth.user) cancelled with 57014 reaches only onApiError, and still answers 503', async () => {
    const email = `rp-${v7()}@example.test`;
    const signer = new AuthClient(base);
    expect((await signer.signUp(email, PASSWORD)).status).toBe(202);
    const token = v7();
    await owner.query(
      `INSERT INTO auth.verification (identifier, value, expires_at)
       SELECT 'reset-password:' || $1, id, now() + $3::interval FROM auth."user" WHERE email = $2`,
      [token, email, RESET_TOKEN_TTL],
    );
    await owner.query('BEGIN');
    await owner.query('LOCK TABLE auth."user" IN ACCESS EXCLUSIVE MODE');
    try {
      // Không cookie: không có lookup session nào (Kysely) chạm bảng bị khoá; lỗi duy nhất là của reclaimer
      // (`UnverifiedLinkRevoker.revoke`, pool auth trực tiếp) ném ra từ hook `before`.
      expectStatus(
        '/api/auth/reset-password',
        await new AuthClient(base).request('post', '/api/auth/reset-password', {
          cookie: false,
          body: { token, newPassword: 'a brand new passphrase' },
        }),
        503,
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('a non-infrastructure DB error (42501, a permission bug) with the DB healthy still answers 500 on both paths, logged at ERROR with its SQLSTATE (review M7)', async () => {
    errors?.mockClear();
    await owner.query('REVOKE SELECT ON auth.session FROM auth_user');
    try {
      expectStatus('/v1/me (cookie)', await c.request('get', '/v1/me'), 500);
      expectStatus(
        '/api/auth/get-session',
        await c.request('get', '/api/auth/get-session'),
        500,
      );
    } finally {
      await owner.query('GRANT SELECT ON auth.session TO auth_user');
    }
    const calls = errors?.mock.calls ?? [];
    const sqlstate = {
      dbError: { errorClass: 'DatabaseError', code: '42501' },
    };
    expect(loggedEvents(calls, 'auth_provider_failed')).toEqual([
      expect.objectContaining(sqlstate),
    ]);
    expect(loggedEvents(calls, 'auth_endpoint_error')).toEqual([
      expect.objectContaining({ ...sqlstate, storageUp: true }),
    ]);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
  });
});
