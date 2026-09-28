import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { AuthClient } from '../../support/auth-client.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery, verifyEmailDirect } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

/**
 * Task 40 I1 (tiêu chí 16, carry-forward 6): kiểm PII trên ĐÚNG stack log của production. API và worker chạy trong
 * process con thật qua `bootstrapApi`/`bootstrapWorker` (nestjs-pino + pino-http, redaction `BASE_REDACT_PATHS`,
 * `errSerializer`/`reqSerializer` của SP1), stdout/stderr được pipe về đây: đọc đúng JSON mà pino (sonic-boom) ghi
 * thẳng vào fd 1 — không qua `ConsoleLogger` hay `process.stdout.write` trong process test.
 */
const mail = mailpitFromInfra();
const PASSWORD = 'correct horse battery';
const WRONG_PASSWORD = 'wrong-password-123';
/** `MAIL_FROM` của `baseTestEnv`: địa chỉ của chính hệ thống, không phải của user. */
const SYSTEM_SENDER = 'noreply@example.test';
/** Địa chỉ email thật: TLD chữ cái (không khớp `node_modules/@scope` hay thư mục pnpm `pkg@1.2.3`). */
const EMAIL_ADDRESS =
  /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi;
const PINO_WARN = 40;
const PINO_ERROR = 50;
const PROCESS_ENV: Record<string, string> = {
  LOG_LEVEL: 'debug',
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
  WORKER_QUEUES: 'events,notifications',
  AUTH_RATE_LIMIT_MAX: '10000',
  AUTH_SIGNIN_RATE_MAX: '1000',
  AUTH_EMAIL_RATE_MAX: '1000',
  AUTH_TWO_FACTOR_RATE_MAX: '1000',
  AUTH_ENUMERATION_MIN_RESPONSE_MS: '0',
};

const secrets = new Set<string>();
const secret = <T extends string | undefined>(value: T): T => {
  if (value) secrets.add(value);
  return value;
};
const sessionSecrets = (c: AuthClient) => {
  for (const [, v] of c.cookies) {
    secret(v);
    secret(decodeURIComponent(v));
    for (const part of decodeURIComponent(v).split('.'))
      if (part.length >= 16) secret(part);
  }
  secret(c.bearer);
};
const newEmail = (tag: string) => secret(`${tag}-${v7()}@example.test`);

type LogLine = Record<string, unknown>;
const isRecord = (v: unknown): v is LogLine =>
  typeof v === 'object' && v !== null;
const jsonLines = (text: string): LogLine[] =>
  text.split('\n').flatMap((l) => {
    if (!l.startsWith('{')) return [];
    const parsed: unknown = JSON.parse(l);
    return isRecord(parsed) ? [parsed] : [];
  });
const reqOf = (l: LogLine): LogLine | undefined =>
  isRecord(l.req) ? l.req : undefined;
const headersOf = (l: LogLine): LogLine | undefined => {
  const h = reqOf(l)?.headers;
  return isRecord(h) ? h : undefined;
};

describe('no PII or secret in the production log stack (pino + pino-http), api and worker processes', () => {
  let api: AppProcess | undefined;
  let worker: AppProcess | undefined;
  let base = '';
  const client = () => new AuthClient(base);
  beforeAll(async () => {
    secret(PASSWORD);
    secret(WRONG_PASSWORD);
    const env = { ...baseTestEnv(), ...PROCESS_ENV };
    // N4: `allSettled`, không `all` — một process khởi động lỗi thì process kia (đã chạy) vẫn được gán để dừng; không
    // bỏ lại process mồ côi giữ BullMQ/pino trên container của lần chạy.
    const [apiStart, workerStart] = await Promise.allSettled([
      startAppProcess('test/support/api-entry.ts', env),
      startAppProcess('test/support/worker-entry.ts', env),
    ]);
    if (apiStart.status === 'fulfilled') api = apiStart.value;
    if (workerStart.status === 'fulfilled') worker = workerStart.value;
    const failed = [apiStart, workerStart].flatMap((r) =>
      r.status === 'rejected' ? [r.reason] : [],
    );
    if (failed.length) {
      await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
      throw new AggregateError(failed, 'app process failed to start');
    }
    if (api?.port === undefined) throw new Error('api did not report a port');
    base = `http://127.0.0.1:${api.port}`;
  });
  afterAll(async () => {
    await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
  });

  it('full flows, then every line either process wrote is free of addresses, passwords, tokens, cookies and API keys', async () => {
    const started = Date.now();
    const u = newEmail('pii');
    const w = client();
    expect((await w.signUp(u, PASSWORD)).status).toBe(202);
    expect((await w.signUp(u, PASSWORD)).status).toBe(202);
    const verifyMail = await mail.waitFor(u, {
      subject: /Verify your email/,
      after: started,
    });
    secret(/[?&]token=([^&\s"<>]+)/.exec(verifyMail.Text)?.[1]);
    expect(
      (await w.verifyEmailFromMailpit(mail, u, started)).status,
    ).toBeLessThan(400);
    expect((await w.signIn(u, WRONG_PASSWORD)).status).toBe(401);
    expect((await w.signIn(newEmail('unknown'), WRONG_PASSWORD)).status).toBe(
      401,
    );
    expect((await w.signIn(u, PASSWORD)).status).toBe(200);
    sessionSecrets(w);
    expect((await w.request('get', '/v1/me')).status).toBe(200);
    expect(
      (await w.request('get', '/v1/me', { cookie: false, bearer: w.bearer }))
        .status,
    ).toBe(200);
    expect(
      (await w.request('get', '/v1/me', { bearer: w.bearer })).status,
    ).toBe(400);

    const created = await w.request('post', '/api/auth/api-key/create', {
      body: { name: 'pii' },
    });
    expect(created.status).toBe(200);
    const key = secret(String(created.body.key));
    expect(
      (await w.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(200);
    const junk = secret(`${key.slice(0, 8)}${v7().replaceAll('-', '')}`);
    expect(
      (await w.request('get', '/v1/me', { cookie: false, apiKey: junk }))
        .status,
    ).toBe(401);
    expect(
      (
        await w.request('post', '/api/auth/api-key/delete', {
          body: { keyId: created.body.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (await w.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(401);

    expect(
      (
        await w.request('post', '/api/auth/request-password-reset', {
          body: { email: u },
          cookie: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await w.request('post', '/api/auth/request-password-reset', {
          body: { email: newEmail('nobody') },
          cookie: false,
        })
      ).status,
    ).toBe(200);
    const reset = await mail.waitFor(u, {
      subject: /Reset your password/,
      after: started,
    });
    const resetToken = /\/reset-password\/([^?\s"<>]+)/.exec(reset.Text)?.[1];
    expect(resetToken).toBeDefined();
    secret(resetToken);

    const other = newEmail('taken');
    await client().signUp(other, PASSWORD);
    await verifyEmailDirect(other);
    expect(
      (
        await w.request('post', '/api/auth/change-email', {
          body: { newEmail: other },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await w.request('post', '/api/auth/change-email', {
          body: { newEmail: newEmail('new') },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await w.request('post', '/api/auth/sign-in/email', {
          body: {
            email: u,
            password: PASSWORD,
            callbackURL: `https://evil.test/?u=${u}`,
          },
          cookie: false,
        })
      ).status,
    ).toBe(422);
    // S2-R42 (16d86d0): đổi email là hai bước — địa chỉ CŨ nhận thư xác nhận trước (link mang token là secret).
    const confirm = await mail.waitFor(u, {
      subject: /Confirm your account email change/,
      after: started,
    });
    secret(/[?&]token=([^&\s"<>]+)/.exec(confirm.Text)?.[1]);

    // Một 5xx thật của Better Auth (lỗi DB không phải APIError, `update-user` không tự bọc): không được in lỗi thô ra
    // stderr (`# SERVER_ERROR` của better-call) — chỉ dòng có cấu trúc của `onApiError`.
    await ownerQuery('REVOKE UPDATE ON auth."user" FROM auth_user');
    try {
      expect(
        (
          await w.request('post', '/api/auth/update-user', {
            body: { name: 'Renamed' },
          })
        ).status,
      ).toBe(500);
    } finally {
      await ownerQuery('GRANT UPDATE ON auth."user" TO auth_user');
    }
    expect((await w.request('post', '/api/auth/sign-out')).status).toBe(200);

    // Tắt êm để pino (sonic-boom) xả hết buffer trước khi đọc.
    await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
    const text = `${api?.output() ?? ''}\n${worker?.output() ?? ''}`;
    const lines = jsonLines(text);

    // Đối chứng: đây thật sự là log của pino-http + app.
    const meWithCookie = lines.find(
      (l) => reqOf(l)?.url === '/v1/me' && headersOf(l)?.cookie !== undefined,
    );
    expect(headersOf(meWithCookie ?? {})?.cookie).toBe('[REDACTED]');
    const clientInput = lines.filter(
      (l) => l.event === 'better_auth_client_input_rejected',
    );
    // M7 / S2-R59: dòng API key sai và redirect lạ có mặt, ở mức warn, không mang giá trị của client.
    expect(
      clientInput.filter((l) => l.level === PINO_WARN).map((l) => l.message),
    ).toEqual(
      expect.arrayContaining([
        'Failed to validate API key:',
        'Invalid callbackURL',
      ]),
    );
    expect(
      lines.some(
        (l) =>
          l.event === 'better_auth_unhandled_error' &&
          l.level === PINO_ERROR &&
          l.errorClass === 'DatabaseError' &&
          l.code === '42501',
      ),
    ).toBe(true);
    // N7: dòng 5xx của mount mang lớp + SQLSTATE THẬT của lỗi gốc (không phải hằng số).
    expect(
      lines.find(
        (l) =>
          l.event === 'auth_endpoint_error' &&
          reqOf(l)?.url === '/api/auth/update-user',
      ),
    ).toMatchObject({
      level: PINO_ERROR,
      errorClass: 'DatabaseError',
      causeCode: '42501',
      status: 500,
    });
    expect(text).not.toContain('# SERVER_ERROR');

    const leaks = [...secrets].flatMap((s) =>
      text
        .split('\n')
        .filter((l) => l.toLowerCase().includes(s.toLowerCase()))
        .map((l) => `${s} in: ${l}`),
    );
    expect(leaks).toEqual([]);
    const addresses = (text.match(EMAIL_ADDRESS) ?? []).filter(
      (a) => a.toLowerCase() !== SYSTEM_SENDER,
    );
    expect(addresses).toEqual([]);
  });
});
