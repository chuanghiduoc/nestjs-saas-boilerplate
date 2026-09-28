import { randomInt, randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { TEMPLATE_KEYS } from '../../src/modules/notifications/templates.js';
import { Mailpit } from '../support/mailpit.js';
import {
  DEFINER_FUNCTIONS_3A,
  DEFINER_READ_TABLES_3A,
} from '../support/tenancy-catalog.js';
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
/** Giá trị bí mật ngắn hơn mức này (vd. cờ `true`) không phải credential và sẽ khớp nhầm log vô hại. */
const MIN_SECRET_LENGTH = 16;
/**
 * `forbidden` nhận từng giá trị nhạy cảm NGAY KHI sinh ra (spec §2 tiêu chí 16): email, token của link xác thực, header
 * cookie và từng giá trị cookie session, bearer (`set-auth-token`).
 */
async function verifiedDevice(
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
 * Plan 3A trên image production (`NODE_ENV=production`, TLS mọi nơi, `docker compose --profile app`). Task 12 thêm
 * kịch bản identity, Task 16 schema tenancy, Task 26 xoá tài khoản có guard, Task 29 luồng tenancy đầy đủ.
 */
describe('prod-like smoke: plan 3A', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const since = new Date().toISOString();
  const mail = new Mailpit(mailpitApiUrl);
  /** Không dòng log nào của api/worker được chứa các giá trị này (spec §2 tiêu chí 16). */
  const forbidden: string[] = [PASSWORD];

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
  it('the tenancy schema of 3A migrated from dist: FORCE RLS, definer functions owned by tenancy_definer, 19 permissions, schedules linked to organizations', () => {
    const forced = [...DEFINER_READ_TABLES_3A].sort();
    expect(
      psql(
        `SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${forced.map((t) => `'${t}'`).join(', ')})`,
      ),
    ).toBe(forced.map((t) => `${t}:true:true`).join(','));
    const fns = [...DEFINER_FUNCTIONS_3A].sort();
    // Hàm definer do DDL giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE` tạo ra: chủ là tenancy_definer, SECURITY
    // DEFINER, app_user gọi được, PUBLIC không.
    expect(
      psql(
        `SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || has_function_privilege('app_user', p.oid, 'EXECUTE')::text || ':' || (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))::text, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${fns.map((f) => `'${f}'`).join(', ')})`,
      ),
    ).toBe(fns.map((f) => `${f}:tenancy_definer:true:true:false`).join(','));
    expect(psql(`SELECT count(*) FROM permissions`)).toBe('19');
    expect(
      psql(
        `SELECT count(*) FROM pg_constraint WHERE conname = 'scheduled_tasks_org_fk'`,
      ),
    ).toBe('1');
    expect(
      psql(
        `SELECT count(*) FROM pg_trigger WHERE tgname = 'scheduled_tasks_suspend_if_org_deleted' AND NOT tgisinternal`,
      ),
    ).toBe('1');
  });
  it('identity of 3A on the production image: oak_ prefix refused, an oak_ key is 401, an uppercase admin target id is 422', async () => {
    const { device, email } = await verifiedDevice(apiUrl, mail, forbidden);
    const created = await device.call('POST', '/api/auth/api-key/create', {
      body: { name: 'smoke', prefix: 'oak_x' },
    });
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({
      errors: [{ path: 'prefix' }],
    });
    const anon = new Device(apiUrl);
    const oakKey = `oak_${randomUUID().replaceAll('-', '')}`;
    forbidden.push(oakKey);
    expect(
      (
        await anon.call('GET', '/v1/me', {
          headers: { 'x-api-key': oakKey },
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
    // Chạy sau ca identity (vitest chạy `it` theo thứ tự khai báo): `forbidden` đã có mọi giá trị ca đó sinh ra.
    expect(forbidden.length).toBeGreaterThan(1);
    assertCleanLogs(logsSince(since), forbidden);
  });
});
