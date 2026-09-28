import { randomInt, randomUUID } from 'node:crypto';
import { TOTP, URI } from 'otpauth';
import { describe, expect, inject, it } from 'vitest';
import { Mailpit, type MailpitMessage } from '../support/mailpit.js';
import {
  SMOKE_BASE_URL,
  SMOKE_ENUMERATION_FLOOR_MS,
  SMOKE_LOCKOUT_MAX,
} from './smoke-app-env.js';
import {
  CookieJar,
  assertCleanLogs,
  compose,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

const PASSWORD = 'smoke correct horse battery';
const EVIL = 'https://evil.example.test';
/** Relay outbox + worker + SMTP STARTTLS trên image thật: rộng tay hơn e2e. */
const MAIL_TIMEOUT_MS = 60_000;
const VERIFY_SUBJECT = /Verify your email/;
const CONFIRM_SUBJECT = /Confirm your account email change/;
const TWO_FACTOR_SUBJECT = /Two-factor authentication turned on/;
/** Link `/api/auth/verify-email?...` trong phần text của thư; host phải là AUTH_BASE_URL (https, sau ingress). */
const VERIFY_LINK = /https:\/\/localhost\/api\/auth\/verify-email\?[^\s"<>]+/;
/** Role app mà init script (`docker/postgres/init/01-roles.sh`) gắn statement_timeout; readiness đọc chính các giá trị này. */
/** Đủ cho một lần `compose run` của api tới lúc validate config và thoát (vài giây trên máy dev). */
const API_REFUSAL_TIMEOUT_MS = 60_000;
const TIMED_ROLES = ['app_user', 'app_relay', 'auth_user'] as const;

type CallOpts = {
  body?: unknown;
  /** `null` = không gửi Origin; mặc định là origin tin cậy (AUTH_BASE_URL). */
  origin?: string | null;
  /** `false` = không gửi cookie của jar và không nhận Set-Cookie vào jar; chuỗi = gửi đúng header này. */
  cookie?: boolean | string;
  bearer?: string;
  apiKey?: string;
};

/**
 * Một "thiết bị" của người dùng phía sau ingress: cookie jar riêng và IP client riêng. Smoke đóng vai ingress
 * (terminate TLS, gắn `X-Forwarded-For`; api tin đúng một hop, `HTTP_TRUST_PROXY=1`), nên mỗi client một IP như
 * người dùng thật và rate limit theo IP giữ giá trị production.
 */
class SmokeClient {
  readonly jar = new CookieJar();
  /** Dải 198.18.0.0/15 (benchmark, RFC 2544), như client e2e. */
  readonly ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
  bearer = '';
  constructor(private readonly apiUrl: string) {}

  async call(method: string, path: string, o: CallOpts = {}) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': this.ip,
    };
    if (o.origin !== null) headers.origin = o.origin ?? SMOKE_BASE_URL;
    const cookie =
      typeof o.cookie === 'string'
        ? o.cookie
        : o.cookie === false
          ? ''
          : this.jar.header();
    if (cookie) headers.cookie = cookie;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (o.apiKey) headers['x-api-key'] = o.apiKey;
    const started = performance.now();
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      redirect: 'manual',
    });
    const elapsedMs = performance.now() - started;
    if (o.cookie === undefined) this.jar.absorb(res);
    const token = res.headers.get('set-auth-token');
    if (token) this.bearer = token;
    return Object.assign(res, { elapsedMs });
  }
  signIn(email: string, password: string) {
    return this.call('POST', '/api/auth/sign-in/email', {
      body: { email, password },
    });
  }
}

const verifyPath = (msg: MailpitMessage): string => {
  const link = VERIFY_LINK.exec(msg.Text)?.[0];
  if (!link) throw new Error('no https verify-email link in the email');
  const u = new URL(link.replaceAll('&amp;', '&'));
  return `${u.pathname}${u.search}`;
};

describe('prod-like smoke: identity + email (NODE_ENV=production, TLS everywhere)', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const mail = new Mailpit(mailpitApiUrl);
  const since = new Date().toISOString();
  const client = () => new SmokeClient(apiUrl);
  /** Link trong thư mở từ hộp thư: thiết bị khác, không cookie. */
  const openLink = (msg: MailpitMessage) =>
    client().call('GET', verifyPath(msg), { cookie: false });
  const email = `smoke-${randomUUID()}@example.test`;
  const newEmail = `smoke-new-${randomUUID()}@example.test`;
  const victim = `lock-${randomUUID()}@example.test`;
  const unavailable = `unavail-${randomUUID()}@example.test`;
  const web = client();
  let apiKey = '';
  let sessionCookie = '';

  it('sign-up answers 202 no faster than the enumeration floor, and the verification email arrives through SMTP STARTTLS', async () => {
    const started = await mail.now();
    const res = await web.call('POST', '/api/auth/sign-up/email', {
      body: { email, password: PASSWORD, name: 'Smoke' },
      cookie: false,
    });
    expect(res.status).toBe(202);
    // S2-R58 bật trong production (luật: > 0): response bị đệm tới mức sàn.
    expect(res.elapsedMs).toBeGreaterThanOrEqual(SMOKE_ENUMERATION_FLOOR_MS);
    const msg = await mail.waitFor(email, {
      subject: VERIFY_SUBJECT,
      timeoutMs: MAIL_TIMEOUT_MS,
      after: started,
    });
    expect((await openLink(msg)).status).toBeLessThan(400);
  });

  it('sign-in sets a Secure, HttpOnly, SameSite=Lax __Secure- session cookie and a mobile bearer', async () => {
    const res = await web.signIn(email, PASSWORD);
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.includes('.session_token='));
    expect(session).toMatch(/^__Secure-[^=;]+\.session_token=[^;]+/);
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
    expect(session).not.toMatch(/;\s*Domain=/i);
    // Không cookie auth nào đi qua kênh không mã hoá.
    for (const c of cookies) expect(c).toMatch(/;\s*Secure/i);
    sessionCookie = /^[^=]+=([^;]+)/.exec(session ?? '')?.[1] ?? '';
    expect(sessionCookie).not.toBe('');
    expect(web.bearer).not.toBe('');
  });

  it('protected route: cookie → 200, anonymous → 401', async () => {
    expect((await web.call('GET', '/v1/me')).status).toBe(200);
    expect((await web.call('GET', '/v1/me', { cookie: false })).status).toBe(
      401,
    );
  });

  it('CSRF: a cookie POST from a cross-site Origin is rejected with 403 origin_not_allowed', async () => {
    const r = await web.call('POST', '/api/auth/update-user', {
      body: { name: 'x' },
      origin: EVIL,
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code?: unknown }).code).toBe(
      'origin_not_allowed',
    );
  });

  it('bearer request (mobile) → 200', async () => {
    expect(
      (await web.call('GET', '/v1/me', { cookie: false, bearer: web.bearer }))
        .status,
    ).toBe(200);
  });

  it('API key request (machine) → 200 as the owning user', async () => {
    const created = await web.call('POST', '/api/auth/api-key/create', {
      body: { name: 'smoke' },
    });
    expect(created.status).toBe(200);
    const { key } = (await created.json()) as { key?: unknown };
    expect(typeof key).toBe('string');
    apiKey = String(key);
    const me = await client().call('GET', '/v1/me', { cookie: false, apiKey });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email });
  });

  it('change email (S2-R42): the OLD address confirms first; the click sends verification to the NEW address; its click changes the email', async () => {
    const requested = await mail.now();
    expect(
      (
        await web.call('POST', '/api/auth/change-email', {
          body: { newEmail },
        })
      ).status,
    ).toBe(202);
    const confirm = await mail.waitFor(email, {
      subject: CONFIRM_SUBJECT,
      timeoutMs: MAIL_TIMEOUT_MS,
      after: requested,
    });
    expect(confirm.To.map((a) => a.Address)).toEqual([email]);
    expect(`${confirm.Text}${confirm.HTML}`).not.toContain(newEmail);
    // Chưa bấm xác nhận: địa chỉ mới chưa nhận gì.
    expect(await mail.messages(newEmail)).toEqual([]);

    const clicked = await mail.now();
    expect((await openLink(confirm)).status).toBeLessThan(400);
    const verify = await mail.waitFor(newEmail, {
      subject: VERIFY_SUBJECT,
      timeoutMs: MAIL_TIMEOUT_MS,
      after: clicked,
    });
    expect((await openLink(verify)).status).toBeLessThan(400);

    const device = client();
    expect((await device.signIn(newEmail, PASSWORD)).status).toBe(200);
    expect((await client().signIn(email, PASSWORD)).status).toBe(401);
  });

  it('2FA: enable, verify with TOTP, the notice email arrives, and a new sign-in needs the code', async () => {
    const en = await web.call('POST', '/api/auth/two-factor/enable', {
      body: { password: PASSWORD },
    });
    expect(en.status).toBe(200);
    const totp = URI.parse(
      String(((await en.json()) as { totpURI?: unknown }).totpURI),
    );
    if (!(totp instanceof TOTP))
      throw new Error('two-factor/enable did not return a TOTP URI');
    const enabled = await mail.now();
    expect(
      (
        await web.call('POST', '/api/auth/two-factor/verify-totp', {
          body: { code: totp.generate() },
        })
      ).status,
    ).toBe(200);
    await mail.waitFor(newEmail, {
      subject: TWO_FACTOR_SUBJECT,
      timeoutMs: MAIL_TIMEOUT_MS,
      after: enabled,
    });

    const pending = client();
    const start = await pending.signIn(newEmail, PASSWORD);
    expect(start.status).toBe(200);
    expect(
      ((await start.json()) as { twoFactorRedirect?: unknown })
        .twoFactorRedirect,
    ).toBe(true);
    expect((await pending.call('GET', '/v1/me')).status).toBe(401);
    expect(
      (
        await pending.call('POST', '/api/auth/two-factor/verify-totp', {
          body: { code: totp.generate() },
        })
      ).status,
    ).toBe(200);
    expect((await pending.call('GET', '/v1/me')).status).toBe(200);
  });

  it('lockout: after the failure budget the account answers 429 with Retry-After', async () => {
    const attacker = client();
    const codes: number[] = [];
    let last: Awaited<ReturnType<SmokeClient['call']>> | undefined;
    for (let i = 0; i <= SMOKE_LOCKOUT_MAX; i++) {
      last = await attacker.call('POST', '/api/auth/sign-in/email', {
        body: { email: victim, password: 'wrong-wrong-wrong' },
        cookie: false,
      });
      codes.push(last.status);
    }
    expect(codes).toEqual([...Array<number>(SMOKE_LOCKOUT_MAX).fill(401), 429]);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('lockout storage failure (auth.login_attempts not writable) answers 503 + Retry-After, never 500', async () => {
    psql('REVOKE INSERT, UPDATE ON auth.login_attempts FROM auth_user');
    try {
      const r = await client().call('POST', '/api/auth/sign-in/email', {
        body: { email: unavailable, password: 'whatever-pass' },
        cookie: false,
      });
      expect(r.status).toBe(503);
      expect(r.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      expect(((await r.json()) as { code?: unknown }).code).toBe(
        'service_unavailable',
      );
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      psql('GRANT INSERT, UPDATE ON auth.login_attempts TO auth_user');
    }
  });

  it('logout revokes the session; the old cookie is 401', async () => {
    const old = web.jar.header();
    expect((await web.call('POST', '/api/auth/sign-out')).status).toBe(200);
    expect((await client().call('GET', '/v1/me', { cookie: old })).status).toBe(
      401,
    );
  });

  it.each([
    [
      'a Better Auth env override',
      'BETTER_AUTH_TRUSTED_ORIGINS=https://evil.example.test',
      /BETTER_AUTH_TRUSTED_ORIGINS must not be set/,
    ],
    [
      'the enumeration floor off',
      'AUTH_ENUMERATION_MIN_RESPONSE_MS=0',
      /AUTH_ENUMERATION_MIN_RESPONSE_MS must be > 0 in production/,
    ],
    [
      'an HTTP budget below the DB deadlines',
      'HTTP_REQUEST_BUDGET_MS=1000',
      /must be below HTTP_REQUEST_BUDGET_MS/,
    ],
  ])(
    'production rules: the api refuses to start with %s',
    (_name, override, error) => {
      // Luật của module (identity) chỉ nạp ở entrypoint api/worker (migrate chỉ nạp config core), nên chạy đúng image
      // api với lệnh mặc định: config sai → thoát trước khi mở cổng. Config lại hợp lệ → server chạy mãi, timeout cắt.
      expect(() =>
        compose(['run', '--rm', '--no-deps', '-e', override, 'api'], {
          timeoutMs: API_REFUSAL_TIMEOUT_MS,
        }),
      ).toThrow(error);
    },
  );

  it('/health/ready is 200 against the real role statement_timeouts, the worker is healthy, and logs carry no PII and no errors', async () => {
    // Readiness (S2-R67/S2-R70) từ chối statement_timeout 0 hay ≥ deadline phía client của pool: các role phải có
    // giá trị thật từ init script, và api vẫn ready với chúng.
    const settings = psql(
      `SELECT r.rolname || '=' || coalesce((SELECT s FROM unnest(r.rolconfig) s WHERE s LIKE 'statement_timeout=%'), '')
         FROM pg_roles r WHERE r.rolname IN (${TIMED_ROLES.map((n) => `'${n}'`).join(', ')}) ORDER BY r.rolname`,
    ).split(/\r?\n/);
    expect(settings).toHaveLength(TIMED_ROLES.length);
    for (const s of settings) expect(s).toMatch(/=statement_timeout=[1-9]/);
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(
      logsSince(since),
      [
        email,
        newEmail,
        victim,
        unavailable,
        PASSWORD,
        web.bearer,
        apiKey,
        sessionCookie,
      ].filter(Boolean),
    );
  });
});
