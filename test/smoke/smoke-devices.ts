import { randomInt, randomUUID } from 'node:crypto';
import { URI, type TOTP } from 'otpauth';
import { expect } from 'vitest';
import type { Mailpit } from '../support/mailpit.js';
import { SMOKE_BASE_URL } from './smoke-app-env.js';
import { CookieJar, psql } from './smoke-support.js';

/** Thiết bị smoke dùng chung (tách nguyên văn từ `tenancy.smoke.spec.ts` của 3A, plan 4A Task 13). */
export const PASSWORD = 'smoke-3a correct horse battery';
const VERIFY_LINK = /https:\/\/localhost\/api\/auth\/verify-email\?[^\s"<>]+/;

/** Một thiết bị phía sau ingress giả: cookie jar + IP riêng (`HTTP_TRUST_PROXY=1` của smoke). */
export class Device {
  readonly jar = new CookieJar();
  readonly ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
  constructor(private readonly apiUrl: string) {}
  async call(
    method: string,
    path: string,
    o: {
      body?: unknown;
      headers?: Record<string, string>;
      cookie?: boolean;
    } = {},
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': this.ip,
      origin: SMOKE_BASE_URL,
      ...o.headers,
    };
    if (o.cookie !== false && this.jar.header())
      headers.cookie = this.jar.header();
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      redirect: 'manual',
    });
    if (o.cookie !== false) this.jar.absorb(res);
    return res;
  }
}
/** Đăng ký → thư qua SMTP STARTTLS → xác thực → đăng nhập bằng cookie. */
/** Giá trị bí mật ngắn hơn mức này (vd. cờ `true`) không phải credential và sẽ khớp nhầm log vô hại. */
const MIN_SECRET_LENGTH = 16;
/**
 * `forbidden` nhận từng giá trị nhạy cảm NGAY KHI sinh ra (spec §2 tiêu chí 16): email, token của link xác thực, header
 * cookie và từng giá trị cookie session, bearer (`set-auth-token`).
 */
export async function verifiedDevice(
  apiUrl: string,
  mail: Mailpit,
  forbidden: string[],
): Promise<{ device: Device; email: string }> {
  const device = new Device(apiUrl);
  const email = `smoke3a-${randomUUID()}@example.test`;
  forbidden.push(email);
  expect(
    (
      await device.call('POST', '/api/auth/sign-up/email', {
        body: { email, password: PASSWORD, name: 'Smoke 3A' },
        cookie: false,
      })
    ).status,
  ).toBe(202);
  const msg = await mail.waitFor(email, {
    subject: /Verify your email/,
    timeoutMs: 60_000,
  });
  const link = VERIFY_LINK.exec(msg.Text)?.[0];
  if (!link) throw new Error('no https verify-email link in the email');
  const u = new URL(link.replaceAll('&amp;', '&'));
  const verifyToken = u.searchParams.get('token');
  if (!verifyToken) throw new Error('verify-email link without a token');
  forbidden.push(verifyToken);
  expect(
    (
      await new Device(apiUrl).call('GET', `${u.pathname}${u.search}`, {
        cookie: false,
      })
    ).status,
  ).toBeLessThan(400);
  const signIn = await device.call('POST', '/api/auth/sign-in/email', {
    body: { email, password: PASSWORD },
  });
  expect(signIn.status).toBe(200);
  const cookie = device.jar.header();
  expect(cookie).toMatch(/__Secure-[^=;]+\.session_token=/);
  const bearer = signIn.headers.get('set-auth-token') ?? '';
  expect(bearer).not.toBe('');
  forbidden.push(
    cookie,
    bearer,
    ...cookie
      .split('; ')
      .map((c) => c.slice(c.indexOf('=') + 1))
      .filter((v) => v.length >= MIN_SECRET_LENGTH),
  );
  return { device, email };
}

/**
 * Nhân viên trên image (spec SP3 §5.3 r6, N5-1): đăng nhập bằng mật khẩu (nhân viên chưa có factor: hàng rào (9) chỉ giữ
 * session đăng nhập bằng mật khẩu hiện tại), `enable` + `verify-totp` nhánh bật (session xoay từ session còn sống), rồi
 * step-up TOTP thật. Không SQL nào chèn dấu: production có đúng trạng thái này sau ba lời gọi HTTP.
 *
 * Spike T7a: nhánh bật trả session MỚI chỉ ở `Set-Cookie`/`set-auth-token`; `bearer` là của session mới đó (đã step-up).
 */
export async function staffDevice(
  apiUrl: string,
  mail: Mailpit,
  forbidden: string[],
): Promise<{ device: Device; email: string; totp: TOTP; bearer: string }> {
  const { device, email } = await verifiedDevice(apiUrl, mail, forbidden);
  psql(
    `UPDATE auth."user" SET role = 'admin' WHERE email = '${email.replaceAll("'", "''")}'`,
  );
  const relogin = await device.call('POST', '/api/auth/sign-in/email', {
    body: { email, password: PASSWORD },
  });
  expect(relogin.status).toBe(200);
  const en = await device.call('POST', '/api/auth/two-factor/enable', {
    body: { password: PASSWORD },
  });
  expect(en.status).toBe(200);
  const body = (await en.json()) as { totpURI: string };
  const totp = URI.parse(body.totpURI) as TOTP;
  forbidden.push(totp.secret.base32);
  const enabled = await device.call(
    'POST',
    '/api/auth/two-factor/verify-totp',
    {
      body: { code: totp.generate() },
    },
  );
  expect(enabled.status).toBe(200);
  const bearer = enabled.headers.get('set-auth-token') ?? '';
  expect(bearer).not.toBe('');
  const cookie = device.jar.header();
  forbidden.push(
    cookie,
    bearer,
    ...cookie
      .split('; ')
      .map((c) => c.slice(c.indexOf('=') + 1))
      .filter((v) => v.length >= MIN_SECRET_LENGTH),
  );
  // Mã TOTP ở hai lời gọi liền có thể trùng (cùng cửa sổ 30 s): Better Auth không ghi mã đã dùng (Review Focus 4).
  expect(
    (
      await device.call('POST', '/api/auth/two-factor/verify-totp', {
        body: { code: totp.generate() },
      })
    ).status,
  ).toBe(200);
  return { device, email, totp, bearer };
}
