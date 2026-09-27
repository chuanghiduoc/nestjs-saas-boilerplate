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
import type pg from 'pg';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { PublicRoute } from '../../../src/core/http/index.js';
import {
  REDIS,
  REDIS_NAMESPACE,
  type RedisClient,
} from '../../../src/core/redis/index.js';
import {
  IdentityDirectory,
  SessionOnly,
} from '../../../src/modules/identity/index.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { AuthDatabaseReadiness } from '../../../src/modules/identity/infra/better-auth/auth-readiness.js';
import { AuthClient } from '../../support/auth-client.js';
import {
  ownerQuery,
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
/** Mặc định của `AUTH_SESSION_EXPIRES_IN_SEC`: cookie gia hạn mang đúng Max-Age này. */
const SESSION_EXPIRES_IN_SEC = 604800;
/** Giới hạn trước xác thực của app test (S2-R51): nhỏ để một loạt key rác chạm giới hạn nhanh. */
const PRE_AUTH_LIMIT = 4;
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
  let validKey = '';
  beforeAll(async () => {
    app = await startIdentityApp({
      extraImports: [ProbeModule],
      env: {
        THROTTLE_DEFAULT_LIMIT: '5',
        THROTTLE_PRE_AUTH_LIMIT: String(PRE_AUTH_LIMIT),
      },
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
    // User riêng cho các test S2-R53: route throttler theo principal của `c` đã gần ngưỡng ở test khác.
    const k = new AuthClient(app.getHttpServer());
    const kEmail = `k-${v7()}@example.test`;
    await k.signUp(kEmail, PASSWORD);
    await verifyEmailDirect(kEmail);
    await k.signIn(kEmail, PASSWORD);
    validKey = (
      await k.request('post', '/api/auth/api-key/create', {
        body: { name: 'refund' },
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
      await c.request('get', '/probe/who');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  /**
   * CF4: exclude của `PrincipalMiddleware` và route của `AuthMountMiddleware` dùng cùng pattern `${basePath}/{*path}`
   * (path-to-regexp: không phân biệt hoa thường, nhận `/` cuối, so path thô chưa decode). Mỗi path do ĐÚNG MỘT bên xử
   * lý, không bao giờ cả hai, không bao giờ không bên nào. Dấu hiệu nhận biết:
   * - principal: `AuthProvider.authenticate` được gọi với cookie session;
   * - mount: POST cross-site chỉ mang cookie `two_factor` → 403 (CSRF của mount tính mọi cookie có prefix auth,
   *   còn với `PrincipalMiddleware` cookie đó không phải credential → ẩn danh → 404 của Nest);
   * - handler Better Auth: chỉ path chính tắc mới tới `auth.handler`.
   */
  it('CF4: every auth-path variant is handled by exactly one of the mount and PrincipalMiddleware', async () => {
    const sessionCookie = [...c.cookies.keys()].find((k) =>
      k.endsWith('.session_token'),
    );
    if (!sessionCookie) throw new Error('no session cookie');
    const twoFactorOnly = `${sessionCookie.replace(/\.session_token$/, '.two_factor')}=x`;
    const principal = vi.spyOn(app.get(AuthProvider), 'authenticate');
    const handler = vi.spyOn(app.get<AuthInstance>(BETTER_AUTH), 'handler');
    const crossSiteTwoFactor = (p: string) =>
      c.request('post', p, {
        cookie: twoFactorOnly,
        origin: 'https://evil.test',
      });
    try {
      for (const p of [
        '/api/auth/get-session/',
        '/API/AUTH/get-session',
        '/api/auth/',
        '/api/auth/%2e%2e/get-session',
      ]) {
        const r = await c.request('get', p);
        expect([r.status, principal.mock.calls.length], p).toEqual([404, 0]);
        const csrf = await crossSiteTwoFactor(p);
        expect([csrf.status, csrf.body.code], p).toEqual([
          403,
          'origin_not_allowed',
        ]);
      }
      expect(handler).not.toHaveBeenCalled();
      for (const p of [
        '/api/auth',
        '/api/authx',
        '//api/auth/get-session',
        '/api/%61uth/get-session',
      ]) {
        const before = principal.mock.calls.length;
        const r = await c.request('get', p);
        expect([r.status, principal.mock.calls.length - before], p).toEqual([
          404, 1,
        ]);
        expect((await crossSiteTwoFactor(p)).status, p).toBe(404);
      }
      expect(handler).not.toHaveBeenCalled();
      expect((await c.request('get', '/api/auth/get-session')).status).toBe(
        200,
      );
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      principal.mockRestore();
      handler.mockRestore();
    }
  });
  it('S2-R51: a burst of junk API keys from one IP is rate limited BEFORE authentication (no storage probe after the limit), also on 404 paths', async () => {
    const authenticate = vi.spyOn(app.get(AuthProvider), 'authenticate');
    const probe = vi.spyOn(app.get(AuthDatabaseReadiness), 'probe');
    const junk = new AuthClient(app.getHttpServer());
    try {
      const statuses: number[] = [];
      for (let i = 0; i < PRE_AUTH_LIMIT; i++)
        statuses.push(
          (
            await junk.request('get', '/probe/who', {
              cookie: false,
              apiKey: `junk-${i}`,
            })
          ).status,
        );
      expect(statuses).toEqual(Array(PRE_AUTH_LIMIT).fill(401));
      expect(authenticate).toHaveBeenCalledTimes(PRE_AUTH_LIMIT);
      expect(probe).toHaveBeenCalledTimes(PRE_AUTH_LIMIT);
      for (const p of ['/probe/who', '/probe/public', '/no-such-route']) {
        const r = await junk.request('get', p, {
          cookie: false,
          apiKey: 'junk-over-limit',
        });
        expect([r.status, r.body.code], p).toEqual([429, 'rate_limited']);
        expect(r.headers['content-type']).toContain('application/problem+json');
        expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      }
      expect(authenticate).toHaveBeenCalledTimes(PRE_AUTH_LIMIT);
      expect(probe).toHaveBeenCalledTimes(PRE_AUTH_LIMIT);
      // S2-R53 N3: khoá trong Redis là băm, IP client không bao giờ nằm nguyên dạng.
      const redis = app.get<RedisClient>(REDIS);
      const keys = await redis.keys(`${app.get<string>(REDIS_NAMESPACE)}*`);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => k.includes(junk.ip))).toEqual([]);
    } finally {
      authenticate.mockRestore();
      probe.mockRestore();
    }
  });
  it('S2-R53: valid API keys are refunded, so a valid burst above the pre-auth limit from one IP is never 429', async () => {
    const nat = new AuthClient(app.getHttpServer());
    const codes: number[] = [];
    // Rải qua 3 route: throttler theo principal của route (THROTTLE_DEFAULT_LIMIT=5) không được là thứ trả 429.
    for (const p of ['/probe/who', '/v1/me', '/probe/public'])
      for (let i = 0; i < 2; i++)
        codes.push(
          (await nat.request('get', p, { cookie: false, apiKey: validKey }))
            .status,
        );
    expect(codes.length).toBeGreaterThan(PRE_AUTH_LIMIT);
    expect(codes).toEqual(Array(codes.length).fill(200));
  });
  it('S2-R53: in a mixed burst only junk keys count; the limit then blocks before any probe', async () => {
    const probe = vi.spyOn(app.get(AuthDatabaseReadiness), 'probe');
    const mixed = new AuthClient(app.getHttpServer());
    const as = (key: string, p: string) =>
      mixed.request('get', p, { cookie: false, apiKey: key });
    try {
      const codes: number[] = [];
      // Key hợp lệ đi TRƯỚC key rác mỗi vòng: điểm của nó chỉ tạm giữ trong lúc xác thực (consume trước auth) rồi được
      // hoàn, nên sau N vòng bộ đếm = N (chỉ key rác) và mọi request đều tới xác thực.
      for (let i = 0; i < PRE_AUTH_LIMIT; i++) {
        codes.push(
          (await as(validKey, i % 2 ? '/v1/me' : '/probe/who')).status,
        );
        codes.push((await as(`junk-mixed-${i}`, '/probe/who')).status);
      }
      expect(codes).toEqual(
        Array.from({ length: PRE_AUTH_LIMIT * 2 }, (_, i) =>
          i % 2 ? 401 : 200,
        ),
      );
      expect(probe).toHaveBeenCalledTimes(PRE_AUTH_LIMIT);
      // Hết hạn mức (chỉ do key rác): request kế tiếp của IP bị chặn TRƯỚC xác thực, kể cả key hợp lệ.
      expect((await as('junk-mixed-over', '/probe/who')).status).toBe(429);
      expect((await as(validKey, '/v1/me')).status).toBe(429);
      expect(probe).toHaveBeenCalledTimes(PRE_AUTH_LIMIT);
    } finally {
      probe.mockRestore();
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
  it('GET /v1/me: an auth pool failure while loading the user is 503 + Retry-After, a bug with a healthy pool stays 500', async () => {
    const findUser = vi.spyOn(app.get(IdentityDirectory), 'findUser');
    try {
      findUser.mockRejectedValueOnce(
        new Error('timeout exceeded when trying to connect'),
      );
      const down = await c.request('get', '/v1/me');
      expect([down.status, down.body.code]).toEqual([
        503,
        'service_unavailable',
      ]);
      expect(Number(down.headers['retry-after'])).toBeGreaterThan(0);
      findUser.mockRejectedValueOnce(new TypeError('a programming error'));
      const bug = await c.request('get', '/v1/me');
      expect([bug.status, bug.body.code]).toEqual([500, 'internal_error']);
    } finally {
      findUser.mockRestore();
    }
  });
  it('an expired session cookie is REJECTED (401) and the cookie is cleared on the Nest route', async () => {
    const x = new AuthClient(app.getHttpServer());
    const email = `x-${v7()}@example.test`;
    await x.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    await x.signIn(email, PASSWORD);
    await ownerQuery(
      `UPDATE auth.session s SET expires_at = now() - interval '1 minute' FROM auth."user" u WHERE u.id = s.user_id AND u.email = $1`,
      [email],
    );
    const r = await x.request('get', '/v1/me');
    expect([r.status, r.body.code]).toEqual([401, 'unauthenticated']);
    const cleared = sessionCookiesOf(r.headers['set-cookie']);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/Max-Age=0(;|$)/i);
    expect(
      [...x.cookies.keys()].some((k) => k.endsWith('.session_token')),
    ).toBe(false);
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
      const pool = down.get<pg.Pool>(AUTH_POOL);
      const authenticate = vi.spyOn(down.get(AuthProvider), 'authenticate');
      const connect = vi.spyOn(pool, 'connect');
      const query = vi.spyOn(pool, 'query');
      try {
        await request(down.getHttpServer()).get('/probe/public').expect(200);
        expect(authenticate).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
      } finally {
        authenticate.mockRestore();
        connect.mockRestore();
        query.mockRestore();
      }
    } finally {
      await down.close();
    }
  });
});
