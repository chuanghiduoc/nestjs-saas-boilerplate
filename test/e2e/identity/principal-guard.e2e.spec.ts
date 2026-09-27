import {
  Body,
  Controller,
  Get,
  Headers,
  Module,
  Patch,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { PublicRoute } from '../../../src/core/http/index.js';
import { SessionOnly } from '../../../src/modules/identity/index.js';
import { AuthClient } from '../../support/auth-client.js';
import {
  ownerQuery,
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
/** Mặc định của `AUTH_SESSION_EXPIRES_IN_SEC`: cookie gia hạn mang đúng Max-Age này. */
const SESSION_EXPIRES_IN_SEC = 604800;
@Controller('probe')
class ProbeController {
  constructor(private readonly ctx: RequestContext) {}
  @PublicRoute() @Get('public') open() {
    return { ok: true };
  }
  @Get('who') who() {
    return {
      principal: this.ctx.principal(),
      credential: this.ctx.credential(),
    };
  }
  @SessionOnly() @Post('sensitive') sensitive() {
    return { ok: true };
  }
  @Post('echo') echo(@Body() body: unknown, @Req() req: { rawBody?: Buffer }) {
    return { body, raw: req.rawBody?.toString('utf8') ?? null };
  }
  @Patch('merge') merge(
    @Body() body: unknown,
    @Headers('content-type') ct: string,
  ) {
    return { body, ct };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

const sessionCookiesOf = (setCookie: string | string[] | undefined) =>
  (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).filter(
    (c) => /^[^=]*\.session_token=/.test(c),
  );

describe('PrincipalMiddleware + AuthGuard on Nest routes', () => {
  let app: INestApplication;
  let c: AuthClient;
  let apiKey = '';
  beforeAll(async () => {
    app = await startIdentityApp({
      extraImports: [ProbeModule],
      env: { THROTTLE_DEFAULT_LIMIT: '5' },
    });
    c = new AuthClient(app.getHttpServer());
    const email = `g-${v7()}@example.test`;
    await c.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    await c.signIn(email, PASSWORD);
    apiKey = (
      await c.request('post', '/api/auth/api-key/create', {
        body: { name: 'probe' },
      })
    ).body.key;
  });
  afterAll(async () => app?.close());

  it('default deny: anonymous → 401 problem+json; @PublicRoute and health stay open', async () => {
    const r = await request(app.getHttpServer()).get('/probe/who');
    expect([r.status, r.body.code]).toEqual([401, 'unauthenticated']);
    await request(app.getHttpServer()).get('/probe/public').expect(200);
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
  it('a present-but-invalid credential is 401 even on a @PublicRoute (never downgraded to anonymous)', async () => {
    for (const [name, value] of [
      ['x-api-key', ''],
      ['authorization', 'Bearer not-a-real-token'],
    ] as const) {
      const r = await request(app.getHttpServer())
        .get('/probe/public')
        .set(name, value);
      expect([r.status, r.body.code], `${name}`).toEqual([
        401,
        'unauthenticated',
      ]);
    }
  });
  it('PrincipalMiddleware never runs on /api/auth/* (the mount identifies credentials itself)', async () => {
    const spy = vi.spyOn(app.get(AuthProvider), 'authenticate');
    try {
      expect((await c.request('get', '/api/auth/get-session')).status).toBe(
        200,
      );
      expect(spy).not.toHaveBeenCalled();
      // Cùng pattern `${basePath}/{*path}` cho exclude và cho mount (path-to-regexp, không phân biệt hoa thường,
      // nhận `/` cuối): biến thể của path auth vẫn chỉ do mount xử lý (mount tự trả 404), không bao giờ cả hai.
      for (const p of [
        '/api/auth/get-session/',
        '/API/AUTH/get-session',
        '/api/auth/',
      ])
        await c.request('get', p);
      expect(spy).not.toHaveBeenCalled();
      await c.request('get', '/probe/who');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('cookie, bearer and API key all resolve the same user; the key id is in context', async () => {
    const viaCookie = await c.request('get', '/probe/who');
    const viaBearer = await c.request('get', '/probe/who', {
      cookie: false,
      bearer: c.bearer,
    });
    const viaKey = await c.request('get', '/probe/who', {
      cookie: false,
      apiKey,
    });
    expect(viaCookie.body.credential).toEqual({ kind: 'SESSION_COOKIE' });
    expect(viaBearer.body.credential).toEqual({ kind: 'BEARER_SESSION' });
    expect(viaKey.body.credential).toMatchObject({
      kind: 'API_KEY',
      id: expect.any(String),
    });
    expect(
      new Set([
        viaCookie.body.principal.id,
        viaBearer.body.principal.id,
        viaKey.body.principal.id,
      ]).size,
    ).toBe(1);
  });
  it('GET /v1/me by cookie and by API key returns the owning user', async () => {
    const me = await c.request('get', '/v1/me');
    expect(me.status).toBe(200);
    expect(Object.keys(me.body).sort()).toEqual([
      'createdAt',
      'email',
      'emailVerified',
      'id',
      'name',
      'role',
      'twoFactorEnabled',
      'updatedAt',
    ]);
    expect(
      (await c.request('get', '/v1/me', { cookie: false, apiKey })).body.id,
    ).toBe(me.body.id);
  });
  it('@SessionOnly rejects API keys (403) and accepts sessions', async () => {
    expect(
      (
        await c.request('post', '/probe/sensitive', {
          cookie: false,
          apiKey,
        })
      ).status,
    ).toBe(403);
    expect((await c.request('post', '/probe/sensitive')).status).toBe(201);
  });
  it('cookie + bearer on a Nest route → 400 ambiguous_credentials; cookie POST cross-site → 403; bearer cross-site passes', async () => {
    const amb = await c.request('get', '/probe/who', { bearer: c.bearer });
    expect([amb.status, amb.body.code]).toEqual([400, 'ambiguous_credentials']);
    const csrf = await c.request('post', '/probe/echo', {
      origin: 'https://evil.test',
      body: { a: 1 },
    });
    expect([csrf.status, csrf.body.code]).toEqual([403, 'origin_not_allowed']);
    expect(
      (
        await c.request('post', '/probe/echo', {
          origin: 'https://evil.test',
          cookie: false,
          bearer: c.bearer,
          body: { a: 1 },
        })
      ).status,
    ).toBe(201);
  });
  it('SP1 conventions still hold with identity mounted: JSON + rawBody, merge-patch, 415, 413', async () => {
    const e = await c.request('post', '/probe/echo', { body: { a: 1 } });
    expect(e.body).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
    const m = await request(app.getHttpServer())
      .patch('/probe/merge')
      .set('authorization', `Bearer ${c.bearer}`)
      .set('content-type', 'application/merge-patch+json')
      .send('{"a":null}');
    expect(m.body).toEqual({
      body: { a: null },
      ct: 'application/merge-patch+json',
    });
    expect(
      (
        await request(app.getHttpServer())
          .post('/probe/echo')
          .set('authorization', `Bearer ${c.bearer}`)
          .set('content-type', 'text/plain')
          .send('x')
      ).status,
    ).toBe(415);
    expect(
      (
        await request(app.getHttpServer())
          .post('/probe/echo')
          .set('authorization', `Bearer ${c.bearer}`)
          .send({ pad: 'x'.repeat(2 * 1024 * 1024) })
      ).status,
    ).toBe(413);
  });
  it('sliding renewal: a cookie session past updateAge gets its renewed cookie on a Nest route; a bearer session is renewed without Set-Cookie', async () => {
    const r = new AuthClient(app.getHttpServer());
    const email = `r-${v7()}@example.test`;
    await r.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    await r.signIn(email, PASSWORD);
    const age = () =>
      ownerQuery(
        `UPDATE auth.session s SET expires_at = now() + interval '1 hour' FROM auth."user" u WHERE u.id = s.user_id AND u.email = $1`,
        [email],
      );
    const expiresInSec = async () =>
      (
        await ownerQuery<{ sec: number }>(
          `SELECT extract(epoch FROM (s.expires_at - now()))::int AS sec FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
          [email],
        )
      )[0]?.sec ?? 0;

    await age();
    const viaCookie = await r.request('get', '/v1/me');
    expect(viaCookie.status).toBe(200);
    const renewed = sessionCookiesOf(viaCookie.headers['set-cookie']);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toMatch(
      new RegExp(`Max-Age=${SESSION_EXPIRES_IN_SEC}(;|$)`, 'i'),
    );
    expect(await expiresInSec()).toBeGreaterThan(SESSION_EXPIRES_IN_SEC - 60);
    // Cookie vẫn dùng được sau khi gia hạn (client đã nhận `Set-Cookie`).
    expect((await r.request('get', '/v1/me')).status).toBe(200);

    await age();
    const viaBearer = await r.request('get', '/v1/me', {
      cookie: false,
      bearer: r.bearer,
    });
    expect(viaBearer.status).toBe(200);
    // Client bearer có cookie jar sẽ gửi cả cookie lẫn bearer ở request sau → 400 ambiguous: không gửi cookie cho nó.
    expect(viaBearer.headers['set-cookie']).toBeUndefined();
    expect(await expiresInSec()).toBeGreaterThan(SESSION_EXPIRES_IN_SEC - 60);
  });
  it('the throttler counts per authenticated principal, not per IP', async () => {
    const other = new AuthClient(app.getHttpServer());
    const email = `t-${v7()}@example.test`;
    await other.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    await other.signIn(email, PASSWORD);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push(
        (
          await c.request('get', '/probe/who', {
            cookie: false,
            bearer: c.bearer,
          })
        ).status,
      );
    expect(codes).toContain(429);
    expect(
      (
        await other.request('get', '/probe/who', {
          cookie: false,
          bearer: other.bearer,
        })
      ).status,
    ).toBe(200);
  });
});

describe('auth storage down: public routes', () => {
  it('a credential on a @PublicRoute → 503 with Retry-After; anonymous stays 200 without touching the auth DB', async () => {
    const down = await startIdentityApp({
      extraImports: [ProbeModule],
      env: { DB_AUTH_PORT: '1', DB_AUTH_CONNECTION_TIMEOUT_MS: '200' },
    });
    try {
      const r = await request(down.getHttpServer())
        .get('/probe/public')
        .set('authorization', 'Bearer some-session-token');
      expect([r.status, r.headers['content-type']]).toEqual([
        503,
        expect.stringContaining('application/problem+json'),
      ]);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      await request(down.getHttpServer()).get('/probe/public').expect(200);
    } finally {
      await down.close();
    }
  });
});
