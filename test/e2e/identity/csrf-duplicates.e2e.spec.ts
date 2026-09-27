import {
  Controller,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient, TEST_ORIGIN } from '../../support/auth-client.js';
import {
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
const CROSS_SITE = 'https://evil.test';
@Controller('probe')
class ProbeController {
  @Post('write') write() {
    return { ok: true };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

type RawResult = { status: number; code?: string };
/**
 * Gửi raw header (giữ bản trùng) để kiểm luật trên `rawHeaders`. Header dạng mảng thô: Node KHÔNG tự thêm `Host`, và
 * thiếu `Host` thì chính parser HTTP của Node trả 400 rỗng — test sẽ "qua" nhờ lỗi đó (Task 36 review M4). Vì vậy
 * `Host` luôn được gửi, và kết quả luôn phải là problem+json có `code` (không có `code` → không phải từ app).
 */
function rawRequest(
  app: INestApplication,
  method: string,
  path: string,
  headers: readonly string[],
  body?: string,
): Promise<RawResult> {
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: [
        'host',
        `127.0.0.1:${port}`,
        ...headers,
        ...(body === undefined
          ? []
          : [
              'content-type',
              'application/json',
              'content-length',
              String(Buffer.byteLength(body)),
            ]),
      ],
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d: Buffer) => {
        body += d.toString();
      });
      res.on('end', () => {
        const parsed: unknown = body.startsWith('{')
          ? JSON.parse(body)
          : undefined;
        const code =
          typeof parsed === 'object' &&
          parsed !== null &&
          'code' in parsed &&
          typeof parsed.code === 'string'
            ? parsed.code
            : undefined;
        resolve({ status: res.statusCode ?? 0, code });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('CSRF matrix (spec §5.6.2) and duplicate credentials (spec §5.6.1)', () => {
  let app: INestApplication;
  let c: AuthClient;
  let cookie = '';
  beforeAll(async () => {
    app = await startIdentityApp({
      extraImports: [ProbeModule],
      env: { AUTH_COOKIE_PREFIX: 'svc' },
    });
    await app.listen(0, '127.0.0.1');
    c = new AuthClient(app.getHttpServer());
    const email = `c-${v7()}@example.test`;
    await c.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    await c.signIn(email, PASSWORD);
    cookie = c.cookieHeader();
  });
  afterAll(async () => app?.close());

  it.each([
    ['cookie + trusted Origin', { origin: TEST_ORIGIN }, 'pass'],
    [
      'cookie, only a trusted Referer',
      { origin: null, headers: { referer: `${TEST_ORIGIN}/page` } },
      403,
    ],
    ['cookie, neither Origin nor Sec-Fetch-Site', { origin: null }, 403],
    ['cookie + cross-site Origin', { origin: CROSS_SITE }, 403],
    [
      'cookie + same-site other-origin',
      { origin: 'http://other.localhost:3000' },
      403,
    ],
    [
      'cookie + trusted host on another scheme',
      { origin: 'https://localhost:3000' },
      403,
    ],
    ['cookie + opaque Origin "null"', { origin: 'null' }, 403],
    [
      'cookie + Sec-Fetch-Site same-site',
      { origin: null, headers: { 'sec-fetch-site': 'same-site' } },
      403,
    ],
  ] as const)(
    '%s on a Nest route and on /api/auth/update-user',
    async (_n, opts, want) => {
      for (const [path, body] of [
        ['/probe/write', {}],
        ['/api/auth/update-user', { name: 'N' }],
      ] as const) {
        const r = await c.request('post', path, { ...opts, cookie, body });
        if (want === 'pass') expect(r.status, path).toBeLessThan(400);
        else
          expect([r.status, r.body.code], path).toEqual([
            403,
            'origin_not_allowed',
          ]);
      }
    },
  );

  /**
   * Hàng "không Origin, `Sec-Fetch-Site: same-origin`" của ma trận §5.6.2. Kiểm của mình cho qua ở cả hai nơi. Trên
   * `/api/auth/*` kiểm tra có sẵn của Better Auth vẫn chạy phía sau như lớp thứ hai (§5.6.2, A.2): nó đòi `Origin`
   * hoặc `Referer` khi request có cookie (`validateOrigin`, `api/middlewares/origin-check.mjs` 1.7.6) và trả
   * `MISSING_OR_NULL_ORIGIN` → `403 origin_not_allowed`. Trình duyệt luôn gửi `Origin` với POST fetch/XHR, nên hàng
   * này chỉ gặp ở client tự viết; chặt hơn là an toàn.
   */
  it('cookie, no Origin, Sec-Fetch-Site same-origin: passes our check (Nest route); Better Auth layer 2 still demands an Origin', async () => {
    const opts = {
      origin: null,
      headers: { 'sec-fetch-site': 'same-origin' },
    } as const;
    expect(
      (await c.request('post', '/probe/write', { ...opts, cookie, body: {} }))
        .status,
    ).toBe(201);
    // Cùng request mà có `Referer` tin cậy: lớp 2 có nguồn để kiểm và cho qua; mình vẫn chỉ dựa vào Sec-Fetch-Site.
    const withReferer = await c.request('post', '/api/auth/update-user', {
      origin: null,
      headers: {
        'sec-fetch-site': 'same-origin',
        referer: `${TEST_ORIGIN}/page`,
      },
      cookie,
      body: { name: 'N' },
    });
    expect(withReferer.status).toBe(200);
    const bare = await c.request('post', '/api/auth/update-user', {
      ...opts,
      cookie,
      body: { name: 'N' },
    });
    expect([bare.status, bare.body.code]).toEqual([403, 'origin_not_allowed']);
  });

  it('an unsafe method outside POST/PUT/PATCH/DELETE (PROPFIND) is CSRF-checked too (SAFE_METHODS is an allow-list)', async () => {
    for (const path of ['/probe/write', '/api/auth/update-user'])
      expect(
        // Có body JSON hợp lệ: không bị 415 trước, nên chính kiểm CSRF phải chặn.
        await rawRequest(
          app,
          'PROPFIND',
          path,
          ['cookie', cookie, 'origin', CROSS_SITE],
          '{}',
        ),
        path,
      ).toEqual({ status: 403, code: 'origin_not_allowed' });
    // Đối chứng: cùng request với Origin tin cậy qua được CSRF (route không có PROPFIND → 404, không phải 403).
    expect(
      await rawRequest(
        app,
        'PROPFIND',
        '/probe/write',
        ['cookie', cookie, 'origin', TEST_ORIGIN],
        '{}',
      ),
    ).toEqual({
      status: 404,
      code: 'not_found',
    });
  });

  it('POST /two-factor/verify-totp with only the two_factor cookie and a cross-site Origin → 403', async () => {
    const r = await new AuthClient(app.getHttpServer()).request(
      'post',
      '/api/auth/two-factor/verify-totp',
      {
        origin: CROSS_SITE,
        cookie: 'svc.two_factor=abc',
        body: { code: '000000' },
      },
    );
    expect([r.status, r.body.code]).toEqual([403, 'origin_not_allowed']);
  });

  it('sign-out with cookie + bearer from a cross-site Origin → 403 (the cookie keeps it CSRF-checked); nothing revoked', async () => {
    const r = await c.request('post', '/api/auth/sign-out', {
      origin: CROSS_SITE,
      bearer: c.bearer,
    });
    expect([r.status, r.body.code]).toEqual([403, 'origin_not_allowed']);
    expect(
      (await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer }))
        .status,
    ).toBe(200);
  });

  it('bearer only with a cross-site Origin is exempt from CSRF', async () => {
    expect(
      (
        await c.request('post', '/probe/write', {
          origin: CROSS_SITE,
          cookie: false,
          bearer: c.bearer,
        })
      ).status,
    ).toBe(201);
    const r = await c.request('post', '/api/auth/update-user', {
      origin: CROSS_SITE,
      cookie: false,
      bearer: c.bearer,
      body: { name: 'B' },
    });
    expect(r.status).toBe(200);
  });

  it("a GET OAuth callback from a cross-site context is not CSRF-checked (a bad state is Better Auth's error)", async () => {
    const r = await c.request(
      'get',
      '/api/auth/callback/google?state=bogus&code=x',
      {
        origin: CROSS_SITE,
        cookie: false,
      },
    );
    expect(r.status).not.toBe(403);
  });

  it.each([
    [
      'two Authorization headers',
      ['authorization', 'Bearer a', 'authorization', 'Bearer b'],
    ],
    ['two API key headers', ['x-api-key', 'a', 'x-api-key', 'b']],
    ['an API key list', ['x-api-key', 'a, b']],
    [
      'two Cookie headers with session cookies',
      ['cookie', 'svc.session_token=a', 'cookie', 'svc.session_token=b'],
    ],
    [
      'the same session cookie twice',
      ['cookie', 'svc.session_token=a; svc.session_token=b'],
    ],
    [
      '__Secure- and plain session cookie',
      ['cookie', '__Secure-svc.session_token=a; svc.session_token=b'],
    ],
    [
      'two_factor cookie twice',
      ['cookie', 'svc.two_factor=a; svc.two_factor=b'],
    ],
    ['malformed Authorization', ['authorization', 'Token abc']],
    ['empty Bearer token', ['authorization', 'Bearer ']],
    [
      'cookie + bearer',
      ['cookie', 'svc.session_token=a', 'authorization', 'Bearer b'],
    ],
    ['API key + bearer', ['x-api-key', 'a', 'authorization', 'Bearer b']],
    ['cookie + API key', ['cookie', 'svc.session_token=a', 'x-api-key', 'b']],
  ])(
    '%s → 400 ambiguous_credentials on Nest routes and /api/auth/*',
    async (_n, headers) => {
      for (const path of ['/v1/me', '/api/auth/get-session'])
        expect(await rawRequest(app, 'GET', path, [...headers]), path).toEqual({
          status: 400,
          code: 'ambiguous_credentials',
        });
    },
  );

  it('a raw request without duplicates reaches the app (control for the raw helper: Host is sent)', async () => {
    expect(
      await rawRequest(app, 'GET', '/v1/me', [
        'authorization',
        `Bearer ${c.bearer ?? ''}`,
      ]),
    ).toEqual({
      status: 200,
      code: undefined,
    });
  });
});
