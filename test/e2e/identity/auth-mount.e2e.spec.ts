import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { BetterAuthApiModule } from '../../../src/modules/identity/infra/better-auth/better-auth-api.module.js';
import { createTestApp } from '../../support/app-factory.js';
import { AuthClient, TEST_ORIGIN } from '../../support/auth-client.js';
import { getInfra } from '../../support/infra.js';

const PASSWORD = 'correct horse battery';
const LIMIT = 2048;
const MAX_413_MS = 2000;
/** Grace của lingering close sau 413 (ruling S2-R12): nhỏ để socket body vô hạn đóng nhanh. */
const LINGER_MS = 300;
const BASE_ENV = {
  HTTP_BODY_LIMIT: `${LIMIT}b`,
  AUTH_COOKIE_PREFIX: 'svc',
  HTTP_TRUST_PROXY: 'loopback',
  AUTH_SIGNIN_RATE_MAX: '1000',
  HTTP_BODY_LIMIT_LINGER_MS: String(LINGER_MS),
};
const imports = () => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: false }),
  OutboxModule.forRoot({ relay: false }),
  EventsModule.forRoot({ worker: false }),
  HttpModule,
  NotificationsModule.forApi(),
  BetterAuthApiModule,
];
async function withEnv<T>(
  env: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) vi.stubEnv(k, v);
  }
}

describe('/api/auth/* self-mount (spec §5.5, §5.6.1, §5.6.2, §5.6.4)', () => {
  let app: INestApplication;
  let owner: pg.Client;
  const server = () => app.getHttpServer();
  const sessions = async (email: string) =>
    (
      await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
        [email],
      )
    ).rows[0]!.n;
  const verified = async (srv = server()) => {
    const email = `m-${v7()}@example.test`;
    const c = new AuthClient(srv);
    await c.signUp(email, PASSWORD);
    await owner.query(
      `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
      [email],
    );
    await c.signIn(email, PASSWORD);
    return { email, c };
  };
  beforeAll(async () => {
    for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
    app = await createTestApp(imports(), {
      beforeInit: applyHttpDefaults,
      bodyParser: false,
    });
    await app.listen(0, '127.0.0.1');
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('an UNBOUNDED chunked body → 413 problem+json within a bounded time, socket closed', async () => {
    const port = (server().address() as AddressInfo).port;
    const started = Date.now();
    const result = await new Promise<{
      status: number;
      type: string | undefined;
    }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/auth/sign-in/email',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
          origin: 'http://localhost:3000',
        },
      });
      let status = 0;
      let type: string | undefined;
      req.on('response', (res) => {
        status = res.statusCode ?? 0;
        type = res.headers['content-type'];
        res.resume();
      });
      req.on('error', () => undefined);
      const t = setInterval(() => {
        if (!req.destroyed) req.write('x'.repeat(512));
      }, 5);
      const deadline = setTimeout(
        () => reject(new Error('no 413 / socket still open')),
        MAX_413_MS * 2,
      );
      req.on('close', () => {
        clearInterval(t);
        clearTimeout(deadline);
        resolve({ status, type });
      });
      req.write('{"email":"');
    });
    expect(result).toEqual({
      status: 413,
      type: expect.stringContaining('application/problem+json'),
    });
    // Socket đóng theo lingering close có hạn (S2-R12): 413 ngay, rồi đóng sau tối đa HTTP_BODY_LIMIT_LINGER_MS.
    expect(Date.now() - started).toBeLessThan(LINGER_MS + MAX_413_MS);
  });
  it('415 on a non-allowlisted content type and 400 on broken JSON, as problem+json', async () => {
    const a = await request(server())
      .post('/api/auth/sign-up/email')
      .set('content-type', 'text/plain')
      .send('x');
    expect([a.status, a.body.code]).toEqual([415, 'unsupported_media_type']);
    const b = await request(server())
      .post('/api/auth/sign-up/email')
      .set('content-type', 'application/json')
      .send('{bad');
    expect([b.status, b.body.code]).toEqual([400, 'malformed_request']);
  });
  it('a malformed sign-up → 422 validation_failed problem+json through the mount, not an empty 202 (review NI1)', async () => {
    const r = await request(server())
      .post('/api/auth/sign-up/email')
      .set('origin', TEST_ORIGIN)
      .send({ email: 'not-an-email', password: 'correct horse battery' });
    expect([r.status, r.headers['content-type'], r.body.code]).toEqual([
      422,
      expect.stringContaining('application/problem+json'),
      'validation_failed',
    ]);
  });
  it('CORS on /api/auth/* comes from core/http (no library CORS): trusted origin allowed with credentials, others not', async () => {
    const ok = await request(server())
      .options('/api/auth/sign-in/email')
      .set('origin', TEST_ORIGIN)
      .set('access-control-request-method', 'POST');
    expect([
      ok.headers['access-control-allow-origin'],
      ok.headers['access-control-allow-credentials'],
    ]).toEqual([TEST_ORIGIN, 'true']);
    const evil = await request(server())
      .options('/api/auth/sign-in/email')
      .set('origin', 'https://evil.test')
      .set('access-control-request-method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('duplicate Authorization headers → 400 ambiguous_credentials, even on GET', async () => {
    const port = (server().address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/auth/get-session',
        headers: [
          ['authorization', 'Bearer a'],
          ['authorization', 'Bearer b'],
        ].flat(),
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });
  it('CSRF runs before the handler: cookie + cross-site Origin → 403; the two_factor cookie alone also counts', async () => {
    const { c } = await verified();
    const r = await c.request('post', '/api/auth/sign-out', {
      origin: 'https://evil.test',
    });
    expect([r.status, r.body.code]).toEqual([403, 'origin_not_allowed']);
    const t = await new AuthClient(server()).request(
      'post',
      '/api/auth/two-factor/verify-totp',
      {
        origin: 'https://evil.test',
        cookie: 'svc.two_factor=abc',
        body: { code: '000000' },
      },
    );
    expect(t.status).toBe(403);
  });
  it('a spoofed x-app-client-ip is overwritten with req.ip', async () => {
    const { email } = await verified();
    const c = new AuthClient(server());
    await c.request('post', '/api/auth/sign-in/email', {
      body: { email, password: PASSWORD },
      cookie: false,
      headers: { 'x-app-client-ip': '6.6.6.6' },
    });
    const { rows } = await owner.query(
      `SELECT ip_address FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
      [email],
    );
    expect(rows.map((r) => r.ip_address)).toContain(c.ip);
    expect(rows.map((r) => r.ip_address)).not.toContain('6.6.6.6');
  });
  it('a client address that does not resolve to an IP fails closed (400), never a shared rate-limit bucket', async () => {
    const r = await new AuthClient(server()).request(
      'post',
      '/api/auth/sign-in/email',
      {
        body: { email: `ip-${v7()}@example.test`, password: PASSWORD },
        cookie: false,
        headers: { 'x-forwarded-for': 'not-an-ip' },
      },
    );
    expect([r.status, r.headers['content-type'], r.body.code]).toEqual([
      400,
      expect.stringContaining('application/problem+json'),
      'malformed_request',
    ]);
  });
  it('sign-out with cookie only: session deleted and the cookie expired with the same Path', async () => {
    const { email, c } = await verified();
    const r = await c.request('post', '/api/auth/sign-out');
    expect(r.status).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(
      /session_token=;.*Path=\//i,
    );
    expect(await sessions(email)).toBe(0);
  });
  it('sign-out with cookie + bearer of two different sessions revokes both', async () => {
    const { email, c } = await verified();
    const other = new AuthClient(server());
    await other.signIn(email, PASSWORD);
    expect(
      (await c.request('post', '/api/auth/sign-out', { bearer: other.bearer }))
        .status,
    ).toBe(200);
    expect(await sessions(email)).toBe(0);
  });
  it('sign-out never reports success when the DB delete fails (503), and never falls through to the native handler', async () => {
    const { email, c } = await verified();
    await owner.query('REVOKE DELETE ON auth.session FROM auth_user');
    try {
      const r = await c.request('post', '/api/auth/sign-out');
      expect([
        r.status,
        r.body.code,
        r.headers['retry-after'] !== undefined,
      ]).toEqual([503, 'service_unavailable', true]);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(await sessions(email)).toBe(1);
    } finally {
      await owner.query('GRANT DELETE ON auth.session TO auth_user');
    }
  });
  it('non-canonical paths (trailing slash, duplicate slashes) → 404 problem+json and never reach the native sign-out', async () => {
    const { email, c } = await verified();
    for (const path of ['/api/auth/sign-out/', '/api/auth//sign-out']) {
      const r = await c.request('post', path);
      expect([r.status, r.headers['content-type']]).toEqual([
        404,
        expect.stringContaining('application/problem+json'),
      ]);
    }
    expect(await sessions(email)).toBe(1);
  });
  it('errors of Better Auth leave as problem+json; impersonation routes do not exist', async () => {
    const r = await new AuthClient(server()).signIn(
      `nobody-${v7()}@example.test`,
      'whatever-long-password',
    );
    expect([r.status, r.headers['content-type'], r.body.code]).toEqual([
      401,
      expect.stringContaining('application/problem+json'),
      'invalid_credentials',
    ]);
    const imp = await new AuthClient(server()).request(
      'post',
      '/api/auth/admin/impersonate-user',
      { body: { userId: v7() } },
    );
    expect([imp.status, imp.headers['content-type']]).toEqual([
      404,
      expect.stringContaining('application/problem+json'),
    ]);
  });
  describe('error mapping per route class (carry-forward 3, S2-R36)', () => {
    const shape = (r: request.Response) => ({
      status: r.status,
      type: r.body.type,
      title: r.body.title,
      code: r.body.code,
      detail: r.body.detail,
      errors: r.body.errors,
    });
    it('public sign-in: a wrong password is indistinguishable from an unknown user (401 invalid_credentials)', async () => {
      const { email } = await verified();
      const wrong = await new AuthClient(server()).signIn(
        email,
        'wrong-password-123',
      );
      const unknown = await new AuthClient(server()).signIn(
        `nobody-${v7()}@example.test`,
        'wrong-password-123',
      );
      expect(shape(wrong)).toEqual(shape(unknown));
      expect(shape(wrong)).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
      });
    });
    it('change-password with a wrong current password → 422 on currentPassword (not 401)', async () => {
      const { c } = await verified();
      const r = await c.request('post', '/api/auth/change-password', {
        body: {
          currentPassword: 'not-the-password-1',
          newPassword: 'another horse battery',
        },
      });
      expect([r.status, r.body.code, r.body.errors?.[0]?.path]).toEqual([
        422,
        'validation_failed',
        'currentPassword',
      ]);
    });
    it('an admin action on a missing user → 404 not_found', async () => {
      const { email, c } = await verified();
      await owner.query(
        `UPDATE auth."user" SET role = 'admin' WHERE email = $1`,
        [email],
      );
      const r = await c.request('post', '/api/auth/admin/ban-user', {
        body: { userId: v7() },
      });
      expect([r.status, r.headers['content-type'], r.body.code]).toEqual([
        404,
        expect.stringContaining('application/problem+json'),
        'not_found',
      ]);
    });
    it('a sensitive operation with a stale session → 403 reauthentication_required', async () => {
      const { email, c } = await verified();
      await owner.query(
        `UPDATE auth.session s SET created_at = now() - interval '1 day' FROM auth."user" u WHERE u.id = s.user_id AND u.email = $1`,
        [email],
      );
      const r = await c.request('post', '/api/auth/change-password', {
        body: {
          currentPassword: PASSWORD,
          newPassword: 'another horse battery',
        },
      });
      expect([r.status, r.body.code]).toEqual([
        403,
        'reauthentication_required',
      ]);
    });
  });
  it('a renewed session keeps its Set-Cookie on success and on a response rewritten into problem+json (carry-forward 7)', async () => {
    const { email, c } = await verified();
    // Hạn còn 1 giờ < expiresIn - updateAge: Better Auth gia hạn session và phát lại cookie ở lần đọc kế tiếp.
    const due = () =>
      owner.query(
        `UPDATE auth.session s SET expires_at = now() + interval '1 hour' FROM auth."user" u WHERE u.id = s.user_id AND u.email = $1`,
        [email],
      );
    await due();
    const ok = await c.request('get', '/api/auth/get-session');
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^svc\.session_token=[^;]+;/),
      ]),
    );
    await due();
    const failed = await c.request('post', '/api/auth/change-password', {
      body: {
        currentPassword: 'not-the-password-1',
        newPassword: 'another horse battery',
      },
    });
    expect([failed.status, failed.headers['content-type']]).toEqual([
      422,
      expect.stringContaining('application/problem+json'),
    ]);
    expect(failed.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^svc\.session_token=[^;]+;/),
      ]),
    );
  });
});

/** Mỗi test dựng app riêng với env khác: MikroORM chỉ cho một app (context `app`) mỗi lúc, nên tách khỏi app chung. */
describe('/api/auth/* self-mount with per-test configuration', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
    vi.unstubAllEnvs();
  });

  it('with a parent cookie domain, sign-in sets Domain and sign-out expires the cookie with the same Domain and Path', async () => {
    const DOMAIN_ORIGIN = 'http://app.lvh.test';
    await withEnv(
      {
        AUTH_BASE_URL: 'http://api.lvh.test',
        AUTH_SECURE_COOKIES: 'true',
        HTTP_CORS_ORIGINS: DOMAIN_ORIGIN,
        AUTH_COOKIE_DOMAIN: 'lvh.test',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      async () => {
        const scoped = await createTestApp(imports(), {
          beforeInit: applyHttpDefaults,
          bodyParser: false,
        });
        try {
          const email = `dom-${v7()}@example.test`;
          const c = new AuthClient(scoped.getHttpServer(), DOMAIN_ORIGIN);
          await c.signUp(email, PASSWORD);
          await owner.query(
            `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
            [email],
          );
          const signIn = await c.signIn(email, PASSWORD);
          expect(String(signIn.headers['set-cookie'])).toMatch(
            /__Secure-svc\.session_token=[^;]+;.*Domain=lvh\.test/i,
          );
          const out = await c.request('post', '/api/auth/sign-out');
          expect(String(out.headers['set-cookie'])).toMatch(
            /__Secure-svc\.session_token=;.*Domain=lvh\.test/i,
          );
          expect(String(out.headers['set-cookie'])).toMatch(/Path=\//);
        } finally {
          await scoped.close();
        }
      },
    );
  });
  it('a burst over the per-IP rate limit → problem+json 429 with Retry-After (from X-Retry-After)', async () => {
    await withEnv({ AUTH_SIGNIN_RATE_MAX: '2' }, async () => {
      const limited = await createTestApp(imports(), {
        beforeInit: applyHttpDefaults,
        bodyParser: false,
      });
      try {
        const c = new AuthClient(limited.getHttpServer());
        const codes: number[] = [];
        let last: request.Response | undefined;
        for (let i = 0; i < 4; i++) {
          last = await c.signIn(`b-${v7()}@example.test`, 'wrong-password-123');
          codes.push(last.status);
        }
        expect(codes.at(-1)).toBe(429);
        expect(last!.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(last!.body.code).toBe('rate_limited');
        expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        await limited.close();
      }
    });
  });
  it('auth DB down → 503 problem+json with Retry-After on sign-in and get-session, and the process stays alive (no unhandled rejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    await withEnv(
      { DB_AUTH_PORT: '1', DB_AUTH_CONNECTION_TIMEOUT_MS: '200' },
      async () => {
        const down = await createTestApp(imports(), {
          beforeInit: applyHttpDefaults,
          bodyParser: false,
        });
        try {
          const c = new AuthClient(down.getHttpServer());
          for (const r of [
            await c.signIn(`d-${v7()}@example.test`, 'whatever-long-password'),
            await c.request('get', '/api/auth/get-session', {
              cookie: 'svc.session_token=x',
            }),
          ])
            expect([
              r.status,
              r.body.code,
              r.headers['retry-after'] !== undefined,
            ]).toEqual([503, 'service_unavailable', true]);
          await new Promise((r) => setTimeout(r, 200));
          expect(unhandled).toEqual([]);
        } finally {
          await down.close();
          process.off('unhandledRejection', onUnhandled);
        }
      },
    );
  });
});
