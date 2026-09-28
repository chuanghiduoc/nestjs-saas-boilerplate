import type { INestApplication } from '@nestjs/common';
import { TOTP, URI } from 'otpauth';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import type { Response } from 'supertest';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { AuthClient, TEST_ORIGIN } from '../../support/auth-client.js';
import {
  ownerQuery,
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
const WRONG_PASSWORD = 'wrong-password-123';
const SIGNIN_RATE_MAX = 4;
/** Chỉ các header khác nhau theo từng response dù cùng nhánh (thời điểm, id request). */
const IGNORED_HEADERS = new Set([
  'date',
  'x-request-id',
  'etag',
  'content-length',
]);
/**
 * Hình dạng quan sát được của một response: status, body nguyên văn và MỌI header (tên + giá trị) trừ các header
 * theo-request ở trên. `Set-Cookie` chỉ giữ TÊN cookie (giá trị luôn khác nhau), đủ để thấy một nhánh có đặt cookie
 * mà nhánh kia không (carry-forward 1).
 */
const shape = (r: Response) => ({
  status: r.status,
  headers: Object.entries(r.headers)
    .filter(([h]) => !IGNORED_HEADERS.has(h))
    .map(([h, v]) =>
      h === 'set-cookie'
        ? [h, [v].flat().map((c: string) => c.split('=')[0])]
        : [h, v],
    )
    .sort(([a], [b]) => String(a).localeCompare(String(b))),
  body: r.text,
});

/**
 * Timing (carry-forward 1, S2-R58). Đo `TIMING_SAMPLES` mẫu mỗi nhánh, xen kẽ hai nhánh (nhiễu của máy/DB rơi đều cho
 * cả hai), so trung vị; MỌI mẫu phải đúng status mong đợi (review M2: không so hai đường lỗi 429/500 với nhau).
 * - `/sign-up/email`, `/request-password-reset`, `/change-email` có mức sàn `AUTH_ENUMERATION_MIN_RESPONSE_MS` ở mount
 *   (S2-R58): cả hai trung vị ≥ mức sàn và lệch nhau không quá `PADDED_TOLERANCE_MS`. Trước S2-R58 đo được nhánh
 *   "email đã có" chậm hơn ~1.5× (6–10 ms) ở quên mật khẩu/đổi email và "email mới" chậm hơn ~20 ms ở đăng ký.
 * - `/sign-in/email` không đệm: cả hai nhánh cùng hash mật khẩu (scrypt), nên chỉ kiểm lớp thời gian thô (`5×+15 ms`).
 * Rủi ro còn lại: nhánh nào chạy lâu hơn mức sàn (DB chậm, pool đầy) vẫn lộ phần vượt; mức sàn phải > nhánh chậm nhất.
 */
const TIMING_SAMPLES = 20;
const TIMING_MAX_RATIO = 5;
const TIMING_SLACK_MS = 15;
const ENUMERATION_FLOOR_MS = 300;
const PADDED_TOLERANCE_MS = 30;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};
async function timeBranches(
  expectedStatus: number,
  a: (i: number) => Promise<Response>,
  b: (i: number) => Promise<Response>,
): Promise<{ a: number; b: number }> {
  const ta: number[] = [];
  const tb: number[] = [];
  const time = async (
    label: string,
    f: () => Promise<Response>,
    into: number[],
  ) => {
    const t0 = performance.now();
    const r = await f();
    into.push(performance.now() - t0);
    expect(r.status, label).toBe(expectedStatus);
  };
  for (let i = 0; i < TIMING_SAMPLES; i++) {
    await time(`branch a, sample ${i}`, () => a(i), ta);
    await time(`branch b, sample ${i}`, () => b(i), tb);
  }
  return { a: median(ta), b: median(tb) };
}
const describeMedians = (m: { a: number; b: number }) =>
  `medians ${m.a.toFixed(1)} ms vs ${m.b.toFixed(1)} ms`;
const expectSameTimingClass = (m: { a: number; b: number }) => {
  const [fast, slow] = [Math.min(m.a, m.b), Math.max(m.a, m.b)];
  expect(slow, describeMedians(m)).toBeLessThanOrEqual(
    fast * TIMING_MAX_RATIO + TIMING_SLACK_MS,
  );
};
const expectPadded = (m: { a: number; b: number }) => {
  expect(Math.min(m.a, m.b), describeMedians(m)).toBeGreaterThanOrEqual(
    ENUMERATION_FLOOR_MS,
  );
  expect(Math.abs(m.a - m.b), describeMedians(m)).toBeLessThanOrEqual(
    PADDED_TOLERANCE_MS,
  );
};

describe('no email enumeration; fail-closed rate limits; untrusted redirect targets', () => {
  let app: INestApplication;
  const client = (ip?: string) =>
    new AuthClient(app.getHttpServer(), TEST_ORIGIN, ip ? { ip } : {});
  const existing = async () => {
    const email = `e-${v7()}@example.test`;
    await client().signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    return email;
  };
  beforeAll(async () => {
    app = await startIdentityApp({
      env: {
        AUTH_SIGNIN_RATE_MAX: String(SIGNIN_RATE_MAX),
        AUTH_SIGNIN_RATE_WINDOW_SEC: '60',
        AUTH_ENUMERATION_MIN_RESPONSE_MS: String(ENUMERATION_FLOOR_MS),
        // Google bật để `/sign-in/social` là một luồng thật (chỉ dựng URL authorize, không gọi mạng).
        AUTH_GOOGLE_CLIENT_ID: 'e2e-google-client',
        AUTH_GOOGLE_CLIENT_SECRET: 'e2e-google-secret',
      },
    });
  });
  afterAll(async () => app?.close());

  describe('no email enumeration (spec §5.8, criterion 9)', () => {
    it('sign-up: new vs existing email are identical (status, headers, body); at most one notice per window', async () => {
      const email = await existing();
      const fresh = shape(
        await client().signUp(`n-${v7()}@example.test`, PASSWORD),
      );
      const again = shape(await client().signUp(email, PASSWORD));
      const third = shape(await client().signUp(email, PASSWORD));
      expect(fresh.status).toBe(202);
      expect(again).toEqual(fresh);
      expect(third).toEqual(fresh);
      expect(fresh.headers.map(([h]) => h)).not.toContain('set-cookie');
      const [user] = await ownerQuery<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email = $1`,
        [email],
      );
      if (!user) throw new Error('user row not found');
      expect(
        await ownerQuery(
          `SELECT 1 FROM email_deliveries WHERE idempotency_key LIKE $1`,
          [`existing-account:${user.id}:%`],
        ),
      ).toHaveLength(1);
    });
    it('concurrent sign-ups with the same email all answer 202 and create exactly one user', async () => {
      const email = `race-${v7()}@example.test`;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => client().signUp(email, PASSWORD)),
      );
      expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
      expect(new Set(results.map((r) => JSON.stringify(shape(r)))).size).toBe(
        1,
      );
      expect(
        await ownerQuery(`SELECT 1 FROM auth."user" WHERE email = $1`, [email]),
      ).toHaveLength(1);
    });
    it('change-email: to a new address vs to a taken address → identical 202', async () => {
      const taken = await existing();
      const me = await existing();
      const c = client();
      await c.signIn(me, PASSWORD);
      const a = shape(
        await c.request('post', '/api/auth/change-email', {
          body: { newEmail: `x-${v7()}@example.test` },
        }),
      );
      const b = shape(
        await c.request('post', '/api/auth/change-email', {
          body: { newEmail: taken },
        }),
      );
      expect(a.status).toBe(202);
      expect(b).toEqual(a);
    });
    it('forgot password: existing vs unknown email → identical responses', async () => {
      const email = await existing();
      const a = shape(
        await client().request('post', '/api/auth/request-password-reset', {
          body: { email },
          cookie: false,
        }),
      );
      const b = shape(
        await client().request('post', '/api/auth/request-password-reset', {
          body: { email: `u-${v7()}@example.test` },
          cookie: false,
        }),
      );
      expect(a.status).toBe(200);
      expect(b).toEqual(a);
    });
    it('resend verification: existing unverified vs unknown email → identical responses', async () => {
      const unverified = `uv-${v7()}@example.test`;
      await client().signUp(unverified, PASSWORD);
      const a = shape(
        await client().request('post', '/api/auth/send-verification-email', {
          body: { email: unverified },
          cookie: false,
        }),
      );
      const b = shape(
        await client().request('post', '/api/auth/send-verification-email', {
          body: { email: `u-${v7()}@example.test` },
          cookie: false,
        }),
      );
      expect(a.status).toBeLessThan(300);
      expect(b).toEqual(a);
    });
    it('sign-in: wrong email vs wrong password → the same 401 invalid_credentials, same shape', async () => {
      const email = await existing();
      const a = await client().signIn(email, WRONG_PASSWORD);
      const b = await client().signIn(`u-${v7()}@example.test`, WRONG_PASSWORD);
      expect([a.status, a.body.code]).toEqual([401, 'invalid_credentials']);
      // Chỉ `requestId` và `timestamp` của problem khác nhau giữa hai response; mọi trường còn lại phải trùng.
      const {
        requestId: _ra,
        timestamp: _ta,
        ...pa
      } = a.body as Record<string, unknown>;
      const {
        requestId: _rb,
        timestamp: _tb,
        ...pb
      } = b.body as Record<string, unknown>;
      expect({ ...shape(b), body: pb }).toEqual({ ...shape(a), body: pa });
    });

    describe(`timing: medians of ${TIMING_SAMPLES} samples per branch (padded to ${ENUMERATION_FLOOR_MS} ms where S2-R58 applies)`, () => {
      it('sign-up new vs existing', async ({ annotate }) => {
        const email = await existing();
        const m = await timeBranches(
          202,
          () => client().signUp(`t-${v7()}@example.test`, PASSWORD),
          () => client().signUp(email, PASSWORD),
        );
        await annotate(
          `sign-up medians: new ${m.a.toFixed(1)} ms, existing ${m.b.toFixed(1)} ms`,
        );
        expectPadded(m);
      });
      it('sign-in wrong password vs unknown user', async ({ annotate }) => {
        // Mỗi mẫu một email riêng: khoá theo tài khoản (lockout) không được làm nhánh nào thành 429 nhanh.
        const known = await Promise.all(
          Array.from({ length: TIMING_SAMPLES }, () => existing()),
        );
        const m = await timeBranches(
          401,
          (i) => client().signIn(known[i] ?? '', WRONG_PASSWORD),
          () => client().signIn(`t-${v7()}@example.test`, WRONG_PASSWORD),
        );
        await annotate(
          `sign-in medians: wrong password ${m.a.toFixed(1)} ms, unknown user ${m.b.toFixed(1)} ms`,
        );
        expectSameTimingClass(m);
      });
      it('forgot password existing vs unknown', async ({ annotate }) => {
        const email = await existing();
        const m = await timeBranches(
          200,
          () =>
            client().request('post', '/api/auth/request-password-reset', {
              body: { email },
              cookie: false,
            }),
          () =>
            client().request('post', '/api/auth/request-password-reset', {
              body: { email: `t-${v7()}@example.test` },
              cookie: false,
            }),
        );
        await annotate(
          `forgot-password medians: existing ${m.a.toFixed(1)} ms, unknown ${m.b.toFixed(1)} ms`,
        );
        expectPadded(m);
      });
      it('change-email free vs taken', async ({ annotate }) => {
        const taken = await existing();
        const me = await existing();
        const c = client();
        await c.signIn(me, PASSWORD);
        const m = await timeBranches(
          202,
          () =>
            c.request('post', '/api/auth/change-email', {
              body: { newEmail: `t-${v7()}@example.test` },
            }),
          () =>
            c.request('post', '/api/auth/change-email', {
              body: { newEmail: taken },
            }),
        );
        await annotate(
          `change-email medians: free ${m.a.toFixed(1)} ms, taken ${m.b.toFixed(1)} ms`,
        );
        expectPadded(m);
      });
    });
  });

  describe('rate limits fail closed (spec §5.7, criterion 8)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('per-IP limit → 429 problem+json with Retry-After (one client = one IP; other clients unaffected)', async () => {
      const codes: number[] = [];
      let retryAfter: string | undefined;
      let type: string | undefined;
      // `AuthClient` giữ một `x-forwarded-for` cố định cho cả vòng đời, nên cùng một client = cùng một IP.
      const sameIp = client();
      for (let i = 0; i < SIGNIN_RATE_MAX + 2; i++) {
        const r = await sameIp.signIn(
          `ip-${v7()}@example.test`,
          WRONG_PASSWORD,
        );
        codes.push(r.status);
        if (r.status === 429) {
          retryAfter = r.headers['retry-after'];
          type = r.headers['content-type'];
        }
      }
      expect(codes).toContain(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
      expect(type).toContain('application/problem+json');
      expect(
        (await client().signIn(`ip-${v7()}@example.test`, WRONG_PASSWORD))
          .status,
      ).toBe(401);
    });
    it('a client-supplied x-app-client-ip is stripped: rotating it does not escape the per-IP bucket (carry-forward 3)', async () => {
      const sameIp = client();
      const codes: number[] = [];
      for (let i = 0; i < SIGNIN_RATE_MAX + 2; i++) {
        const r = await sameIp.request('post', '/api/auth/sign-in/email', {
          body: { email: `xip-${v7()}@example.test`, password: WRONG_PASSWORD },
          cookie: false,
          headers: { 'x-app-client-ip': `203.0.113.${i + 1}` },
        });
        codes.push(r.status);
      }
      expect(codes.slice(0, SIGNIN_RATE_MAX)).toEqual(
        Array.from({ length: SIGNIN_RATE_MAX }, () => 401),
      );
      expect(codes.slice(SIGNIN_RATE_MAX)).toEqual([429, 429]);
    });
    it('a client-supplied x-app-client-ip cannot pick a victim bucket: two IPs claiming the same value stay separate', async () => {
      const victimIp = '198.19.7.7';
      const attacker = client();
      for (let i = 0; i < SIGNIN_RATE_MAX + 1; i++)
        await attacker.request('post', '/api/auth/sign-in/email', {
          body: { email: `atk-${v7()}@example.test`, password: WRONG_PASSWORD },
          cookie: false,
          headers: { 'x-app-client-ip': victimIp },
        });
      expect(
        (
          await client(victimIp).signIn(
            `vic-${v7()}@example.test`,
            WRONG_PASSWORD,
          )
        ).status,
      ).toBe(401);
    });
    it('storage failure on auth.rate_limit (Better Auth layer 1) → 503 with Retry-After on sign-in and 2FA verify, never 500', async () => {
      await ownerQuery(
        `REVOKE INSERT, UPDATE ON auth.rate_limit FROM auth_user`,
      );
      try {
        const a = await client().signIn(
          `s-${v7()}@example.test`,
          'whatever-password',
        );
        const b = await client().request(
          'post',
          '/api/auth/two-factor/verify-totp',
          { body: { code: '000000' }, cookie: false },
        );
        for (const [label, r] of [
          ['sign-in', a],
          ['2fa verify', b],
        ] as const) {
          expect(
            [r.status, r.headers['retry-after'] !== undefined],
            label,
          ).toEqual([503, true]);
          expect(r.headers['content-type'], label).toContain(
            'application/problem+json',
          );
        }
      } finally {
        await ownerQuery(
          `GRANT INSERT, UPDATE ON auth.rate_limit TO auth_user`,
        );
      }
    });
    /**
     * `auth.login_attempts` chỉ giữ khoá theo tài khoản của ĐĂNG NHẬP MẬT KHẨU; khoá 2FA là `accountLockout` có sẵn của
     * plugin `twoFactor` (S2-R6, Task 34), không nằm ở bảng này. Vì vậy lỗi bảng này làm sign-in 503, còn verify-totp
     * (không có cookie `two_factor`) vẫn trả 401 bình thường của Better Auth — không bao giờ 500.
     */
    it('storage failure on auth.login_attempts (layer 2) → 503 with Retry-After on sign-in; 2FA verify does not use it and stays 401', async () => {
      await ownerQuery(
        `REVOKE INSERT, UPDATE ON auth.login_attempts FROM auth_user`,
      );
      try {
        const a = await client().signIn(
          `s-${v7()}@example.test`,
          'whatever-password',
        );
        expect([
          a.status,
          a.body.code,
          a.headers['retry-after'] !== undefined,
        ]).toEqual([503, 'service_unavailable', true]);
        expect(a.headers['content-type']).toContain('application/problem+json');
        const b = await client().request(
          'post',
          '/api/auth/two-factor/verify-totp',
          { body: { code: '000000' }, cookie: false },
        );
        expect([b.status, b.headers['content-type']]).toEqual([
          401,
          expect.stringContaining('application/problem+json'),
        ]);
      } finally {
        await ownerQuery(
          `GRANT INSERT, UPDATE ON auth.login_attempts TO auth_user`,
        );
      }
    });
    /**
     * Task 40 I3 (tiêu chí 8): khoá 2FA của plugin `twoFactor` ghi `failedAttempts`/`lockedUntil` vào `auth.two_factor`
     * (`plugins/two-factor/verify-two-factor.mjs`). Ghi lỗi → Better Auth trả 500 chung, probe DB vẫn lên; mount vẫn
     * phải fail closed 503 trên `/two-factor/*`, không bao giờ 500 — và không cấp session.
     */
    it('2FA lockout storage failure (REVOKE UPDATE on auth.two_factor) with a pending 2FA sign-in → 503 + Retry-After, never 500', async () => {
      const email = await existing();
      const owner = client();
      expect((await owner.signIn(email, PASSWORD)).status).toBe(200);
      const en = await owner.request('post', '/api/auth/two-factor/enable', {
        body: { password: PASSWORD },
      });
      expect(en.status).toBe(200);
      const totp = URI.parse(String(en.body.totpURI));
      if (!(totp instanceof TOTP)) throw new Error('no TOTP URI');
      expect(
        (
          await owner.request('post', '/api/auth/two-factor/verify-totp', {
            body: { code: totp.generate() },
          })
        ).status,
      ).toBe(200);
      const pending = client();
      expect(
        (await pending.signIn(email, PASSWORD)).body.twoFactorRedirect,
      ).toBe(true);
      expect((await pending.request('get', '/v1/me')).status).toBe(401);
      await ownerQuery('REVOKE UPDATE ON auth.two_factor FROM auth_user');
      try {
        const r = await pending.request(
          'post',
          '/api/auth/two-factor/verify-totp',
          { body: { code: '000000' } },
        );
        expect([
          r.status,
          r.body.code,
          r.headers['content-type'],
          Number(r.headers['retry-after']) > 0,
        ]).toEqual([
          503,
          'service_unavailable',
          expect.stringContaining('application/problem+json'),
          true,
        ]);
        expect(r.headers['set-auth-token']).toBeUndefined();
      } finally {
        await ownerQuery('GRANT UPDATE ON auth.two_factor TO auth_user');
      }
      expect((await pending.request('get', '/v1/me')).status).toBe(401);
    });
    /**
     * S2-R51/R53 và throttler của SP1 dùng chung `RateLimiterThrottlerStorage` (Redis + insurance trong bộ nhớ). Redis
     * sập đơn thuần rơi sang insurance (vẫn giới hạn, chaos test SP1); chỉ khi CẢ HAI lỗi thì `consume` của
     * `RateLimiterRedis` reject bằng lỗi không phải `RateLimiterRes` — mô phỏng đúng tình huống đó (như test tích hợp
     * `rate-limiter-storage.spec.ts`), rồi đi qua HTTP thật.
     */
    it('pre-auth limiter storage down (Redis and insurance) → 503 + Retry-After before any API key lookup (S2-R51/R53)', async () => {
      const authenticate = vi.spyOn(app.get(AuthProvider), 'authenticate');
      vi.spyOn(RateLimiterRedis.prototype, 'consume').mockRejectedValue(
        new Error('store and insurance both failed'),
      );
      const r = await client().request('get', '/v1/me', {
        cookie: false,
        apiKey: `junk-${v7()}`,
      });
      expect([r.status, r.body.code, r.headers['content-type']]).toEqual([
        503,
        'service_unavailable',
        expect.stringContaining('application/problem+json'),
      ]);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      // Review M3: `authenticate` (tra API key trong storage auth) không bao giờ được gọi.
      expect(authenticate).not.toHaveBeenCalled();
    });
    it('SP1 throttler storage down (Redis and insurance) → 503 + Retry-After on an authenticated Nest route, never a pass-through (S2-R53 N4)', async () => {
      const email = await existing();
      const c = client();
      await c.signIn(email, PASSWORD);
      expect(
        (await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer }))
          .status,
      ).toBe(200);
      vi.spyOn(RateLimiterRedis.prototype, 'consume').mockRejectedValue(
        new Error('store and insurance both failed'),
      );
      const r = await c.request('get', '/v1/me', {
        cookie: false,
        bearer: c.bearer,
      });
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  /**
   * Carry-forward 5. Better Auth 1.7.6 kiểm `callbackURL`/`redirectTo`/`errorCallbackURL`/`newUserCallbackURL` bằng
   * `originCheckMiddleware` (mọi POST) và `originCheck(...)` riêng của `/verify-email`, `/reset-password/:token` (GET),
   * so với `trustedOrigins` (`matchesOriginPattern`: origin http(s) khớp chính xác; path tương đối chỉ khi an toàn —
   * không `//`, không `\`, không `%2F`/`%5C`). Lỗi `INVALID_*_URL` → `422 validation_failed` (mapper).
   */
  describe('untrusted redirect targets are rejected on every public flow (carry-forward 5)', () => {
    const EVIL_TARGETS = [
      'https://evil.test/steal',
      '//evil.test/steal',
      '/\\evil.test/steal',
      '/%2F%2Fevil.test/steal',
      '%2F%2Fevil.test/steal',
      'https%3A%2F%2Fevil.test%2Fsteal',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://localhost:3000@evil.test/steal',
      'http://localhost:3000.evil.test/steal',
      ' https://evil.test/steal',
    ];
    const expectRejected = (r: Response, label: string) => {
      expect(r.status, label).toBeGreaterThanOrEqual(400);
      expect(r.status, label).toBeLessThan(500);
      expect(r.headers['content-type'], label).toContain(
        'application/problem+json',
      );
      expect(String(r.headers.location ?? ''), label).toBe('');
    };

    it.each(EVIL_TARGETS)('%s', async (evil) => {
      const email = await existing();
      const q = encodeURIComponent(evil);
      const flows: [string, () => Promise<Response>][] = [
        [
          'sign-up callbackURL',
          () =>
            client().request('post', '/api/auth/sign-up/email', {
              body: {
                email: `cb-${v7()}@example.test`,
                password: PASSWORD,
                name: 'C',
                callbackURL: evil,
              },
              cookie: false,
            }),
        ],
        [
          'sign-in callbackURL',
          () =>
            client().request('post', '/api/auth/sign-in/email', {
              body: { email, password: PASSWORD, callbackURL: evil },
              cookie: false,
            }),
        ],
        [
          'sign-in/social callbackURL',
          () =>
            client().request('post', '/api/auth/sign-in/social', {
              body: { provider: 'google', callbackURL: evil },
              cookie: false,
            }),
        ],
        [
          'sign-in/social errorCallbackURL',
          () =>
            client().request('post', '/api/auth/sign-in/social', {
              body: {
                provider: 'google',
                callbackURL: '/ok',
                errorCallbackURL: evil,
              },
              cookie: false,
            }),
        ],
        [
          'sign-in/social newUserCallbackURL',
          () =>
            client().request('post', '/api/auth/sign-in/social', {
              body: {
                provider: 'google',
                callbackURL: '/ok',
                newUserCallbackURL: evil,
              },
              cookie: false,
            }),
        ],
        [
          'send-verification-email callbackURL',
          () =>
            client().request('post', '/api/auth/send-verification-email', {
              body: { email, callbackURL: evil },
              cookie: false,
            }),
        ],
        [
          'verify-email callbackURL (GET)',
          () =>
            client().request(
              'get',
              `/api/auth/verify-email?token=bogus&callbackURL=${q}`,
              { cookie: false },
            ),
        ],
        [
          'request-password-reset redirectTo',
          () =>
            client().request('post', '/api/auth/request-password-reset', {
              body: { email, redirectTo: evil },
              cookie: false,
            }),
        ],
        [
          'reset-password callback (GET)',
          () =>
            client().request(
              'get',
              `/api/auth/reset-password/bogus?callbackURL=${q}`,
              { cookie: false },
            ),
        ],
      ];
      for (const [label, send] of flows) expectRejected(await send(), label);
    });

    it('controls: a trusted absolute or safe relative target is accepted on the same flows', async () => {
      const email = await existing();
      for (const target of [`${TEST_ORIGIN}/welcome`, '/welcome']) {
        expect(
          (
            await client().request('post', '/api/auth/sign-in/email', {
              body: { email, password: PASSWORD, callbackURL: target },
              cookie: false,
            })
          ).status,
          target,
        ).toBe(200);
        const social = await client().request(
          'post',
          '/api/auth/sign-in/social',
          {
            body: {
              provider: 'google',
              callbackURL: target,
              errorCallbackURL: target,
            },
            cookie: false,
          },
        );
        expect(social.status, target).toBe(200);
        expect(new URL(String(social.body.url)).host).toBe(
          'accounts.google.com',
        );
        expect(
          (
            await client().request('post', '/api/auth/request-password-reset', {
              body: { email, redirectTo: target },
              cookie: false,
            })
          ).status,
          target,
        ).toBe(200);
      }
    });
  });
});
