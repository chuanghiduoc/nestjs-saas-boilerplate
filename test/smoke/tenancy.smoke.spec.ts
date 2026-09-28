import { randomInt, randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { TEMPLATE_KEYS } from '../../src/modules/notifications/templates.js';
import { Mailpit } from '../support/mailpit.js';
import { SMOKE_BASE_URL } from './smoke-app-env.js';
import {
  CookieJar,
  assertCleanLogs,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

const PASSWORD = 'smoke-3a correct horse battery';
const VERIFY_LINK = /https:\/\/localhost\/api\/auth\/verify-email\?[^\s"<>]+/;

/** Một thiết bị phía sau ingress giả: cookie jar + IP riêng (`HTTP_TRUST_PROXY=1` của smoke). */
class Device {
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
async function verifiedDevice(
  apiUrl: string,
  mail: Mailpit,
): Promise<{ device: Device; email: string }> {
  const device = new Device(apiUrl);
  const email = `smoke3a-${randomUUID()}@example.test`;
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
  expect(
    (
      await new Device(apiUrl).call('GET', `${u.pathname}${u.search}`, {
        cookie: false,
      })
    ).status,
  ).toBeLessThan(400);
  expect(
    (
      await device.call('POST', '/api/auth/sign-in/email', {
        body: { email, password: PASSWORD },
      })
    ).status,
  ).toBe(200);
  return { device, email };
}

/**
 * Plan 3A trên image production (`NODE_ENV=production`, TLS mọi nơi, `docker compose --profile app`). Task 12 thêm
 * kịch bản identity, Task 16 schema tenancy, Task 26 xoá tài khoản có guard, Task 29 luồng tenancy đầy đủ.
 */
describe('prod-like smoke: plan 3A', () => {
  const { apiUrl } = inject('smoke');
  const since = new Date().toISOString();
  const { mailpitApiUrl } = inject('smoke');
  const mail = new Mailpit(mailpitApiUrl);

  it('the 3A migrations and the tenancy_definer role are in place', () => {
    expect(
      psql(`SELECT string_agg(key, ',' ORDER BY key) FROM email_templates`),
    ).toBe([...TEMPLATE_KEYS].sort().join(','));
    expect(
      psql(
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'scheduled_tasks' AND column_name = 'suspended_at'`,
      ),
    ).toBe('1');
    expect(
      psql(
        `SELECT rolcanlogin::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = 'tenancy_definer'`,
      ),
    ).toBe('false,false');
    expect(
      psql(
        `SELECT count(*) FROM pg_constraint WHERE conname = 'email_deliveries_template_fk'`,
      ),
    ).toBe('1');
  });
  it('identity of 3A on the production image: oak_ prefix refused, an oak_ key is 401, an uppercase admin target id is 422', async () => {
    const { device, email } = await verifiedDevice(apiUrl, mail);
    const created = await device.call('POST', '/api/auth/api-key/create', {
      body: { name: 'smoke', prefix: 'oak_x' },
    });
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({
      errors: [{ path: 'prefix' }],
    });
    const anon = new Device(apiUrl);
    expect(
      (
        await anon.call('GET', '/v1/me', {
          headers: { 'x-api-key': `oak_${randomUUID().replaceAll('-', '')}` },
          cookie: false,
        })
      ).status,
    ).toBe(401);
    psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${email}'`);
    const id = psql(`SELECT id FROM auth."user" WHERE email = '${email}'`);
    // Image lúc này chưa có `UserDeletionGuard` (Task 26): `422` đến từ kiểm dạng `userId` của hook, vốn không cần guard
    // (Task 11, review I1). Task 26 thêm ca xoá tài khoản có guard.
    const r = await device.call('POST', '/api/auth/admin/remove-user', {
      body: { userId: id.toUpperCase() },
    });
    expect(r.status).toBe(422);
    expect(
      psql(`SELECT count(*) FROM auth.session WHERE user_id = '${id}'`),
    ).not.toBe('0');
  });
  it('/health/ready is 200, the worker is healthy, and api/worker logs are clean JSON without errors', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(logsSince(since), [PASSWORD]);
  });
});
