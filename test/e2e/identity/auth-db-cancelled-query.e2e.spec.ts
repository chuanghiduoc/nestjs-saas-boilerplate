import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request, { type Response } from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import {
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';
import { getInfra } from '../../support/infra.js';

const PASSWORD = 'correct horse battery';

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
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
  });

  it('57014 while the DB is healthy: cookie /v1/me and get-session answer 503; a concurrent API-key request that does not touch the lock answers 200', async () => {
    await owner.query('BEGIN');
    await owner.query('LOCK TABLE auth.session IN ACCESS EXCLUSIVE MODE');
    try {
      const [me, session, keyed, ready] = await Promise.all([
        c.request('get', '/v1/me'),
        c.request('get', '/api/auth/get-session'),
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
      // Chạy song song với hai request lỗi, không chạm bảng bị khoá: lỗi đã ghi không tràn sang request khác.
      expect(keyed.status, '/v1/me (api key)').toBe(200);
      // DB thật sự khoẻ trong lúc đó: đây không phải ca "probe thất bại".
      expect(ready.status, '/health/ready').toBe(200);
    } finally {
      await owner.query('ROLLBACK');
    }
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    expect((await c.request('get', '/api/auth/get-session')).status).toBe(200);
  });

  it('a non-infrastructure DB error (42501, a permission bug) with the DB healthy still answers 500 on both paths', async () => {
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
    expect((await c.request('get', '/v1/me')).status).toBe(200);
  });
});
