import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { TEMPLATE_KEYS } from '../../src/modules/notifications/templates.js';
import { TENANCY_CATALOGUE } from '../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { Mailpit } from '../support/mailpit.js';
import {
  DEFINER_FUNCTIONS_3A,
  DEFINER_READ_TABLES_3A,
} from '../support/tenancy-catalog.js';
import { Device, PASSWORD, verifiedDevice } from './smoke-devices.js';
import {
  assertCleanLogs,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

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
  it('the tenancy schema of 3A migrated from dist: FORCE RLS, definer functions owned by tenancy_definer, the tenancy permissions, schedules linked to organizations', () => {
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
    expect(
      psql(
        `SELECT count(*) FROM permissions WHERE key IN (${TENANCY_CATALOGUE.keys.map((k) => `'${k}'`).join(', ')})`,
      ),
    ).toBe(String(TENANCY_CATALOGUE.keys.length));
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
  it('account deletion on the production image: the sole owner of an active org is 409, an uppercase id is 422, after a soft delete the account is deleted', async () => {
    const { device: owner, email: ownerEmail } = await verifiedDevice(
      apiUrl,
      mail,
      forbidden,
    );
    const { device: admin, email: adminEmail } = await verifiedDevice(
      apiUrl,
      mail,
      forbidden,
    );
    psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${adminEmail}'`);
    const ownerId = psql(
      `SELECT id FROM auth."user" WHERE email = '${ownerEmail}'`,
    );
    const created = await owner.call('POST', '/v1/orgs', {
      body: { name: 'Smoke Deletion Org' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const { id: orgId } = z
      .object({ id: z.uuid() })
      .parse(await created.json());
    const Problem = z.object({ code: z.string() });

    const blocked = await admin.call('POST', '/api/auth/admin/remove-user', {
      body: { userId: ownerId },
    });
    expect(blocked.status).toBe(409);
    expect(Problem.parse(await blocked.json()).code).toBe(
      'user_deletion_blocked',
    );
    expect(
      psql(`SELECT count(*) FROM auth.session WHERE user_id = '${ownerId}'`),
    ).not.toBe('0');
    expect(
      psql(`SELECT count(*) FROM auth.account WHERE user_id = '${ownerId}'`),
    ).toBe('1');

    const upper = await admin.call('POST', '/api/auth/admin/remove-user', {
      body: { userId: ownerId.toUpperCase() },
    });
    expect(upper.status).toBe(422);
    expect(Problem.parse(await upper.json()).code).toBe('validation_failed');

    expect((await owner.call('DELETE', `/v1/orgs/${orgId}`)).status).toBe(204);
    expect(
      (
        await admin.call('POST', '/api/auth/admin/remove-user', {
          body: { userId: ownerId },
        })
      ).status,
    ).toBe(200);
    expect(
      psql(`SELECT count(*) FROM auth."user" WHERE id = '${ownerId}'`),
    ).toBe('0');
    expect(
      psql(
        `SELECT count(*) FROM tenancy_users WHERE auth_user_id = '${ownerId}'`,
      ),
    ).toBe('0');
    expect(
      psql(
        `SELECT count(*) FROM outbox_events WHERE org_id = '${orgId}' AND type = 'tenancy.member.removed'`,
      ),
    ).toBe('1');
  });
  it('tenancy on the production image: sign up → verify → create org → rename → soft delete → 404 → restore → account deletion blocked, then allowed after a soft delete', async () => {
    const { device, email } = await verifiedDevice(apiUrl, mail, forbidden);
    const created = await device.call('POST', '/v1/orgs', {
      body: { name: 'Smoke Org' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(await created.json());
    const url = `/v1/orgs/${id}`;
    expect(created.headers.get('location')).toBe(url);
    const list = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(await (await device.call('GET', '/v1/orgs')).json());
    expect(list.data.map((o) => o.id)).toContain(id);
    const got = await device.call('GET', url);
    expect(got.status).toBe(200);
    const renamed = await device.call('PATCH', url, {
      body: { name: 'Smoke Org Renamed' },
      headers: { 'if-match': got.headers.get('etag') ?? '' },
    });
    expect(renamed.status).toBe(200);
    expect((await device.call('DELETE', url)).status).toBe(204);
    expect((await device.call('GET', url)).status).toBe(404);
    const restored = await device.call('POST', `${url}/restore`, {
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(restored.status).toBe(200);
    expect((await device.call('GET', url)).status).toBe(200);
    // member.added, org.created, org.updated, org.deleted, org.restored — cùng transaction với từng thay đổi.
    expect(
      psql(
        `SELECT count(*) FROM outbox_events WHERE org_id = '${id}' AND type LIKE 'tenancy.%'`,
      ),
    ).toBe('5');
    expect(
      psql(
        `SELECT relforcerowsecurity::text FROM pg_class WHERE relname = 'org_members'`,
      ),
    ).toBe('true');

    // Xoá tài khoản (spec §9.6, review I10): org đã khôi phục nên người dùng lại là owner duy nhất của một org hoạt động.
    const userId = psql(`SELECT id FROM auth."user" WHERE email = '${email}'`);
    const { device: admin, email: adminEmail } = await verifiedDevice(
      apiUrl,
      mail,
      forbidden,
    );
    psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${adminEmail}'`);
    const blocked = await admin.call('POST', '/api/auth/admin/remove-user', {
      body: { userId },
    });
    expect(blocked.status).toBe(409);
    expect(
      z.object({ code: z.string() }).parse(await blocked.json()).code,
    ).toBe('user_deletion_blocked');
    expect((await device.call('GET', url)).status).toBe(200);
    expect((await device.call('DELETE', url)).status).toBe(204);
    expect(
      (
        await admin.call('POST', '/api/auth/admin/remove-user', {
          body: { userId },
        })
      ).status,
    ).toBe(200);
    expect(
      psql(`SELECT count(*) FROM auth."user" WHERE id = '${userId}'`),
    ).toBe('0');
    expect(
      psql(
        `SELECT count(*) FROM tenancy_users WHERE auth_user_id = '${userId}'`,
      ),
    ).toBe('0');
    // Thêm org.deleted (lần hai) và member.removed { reason: ACCOUNT_DELETED }.
    expect(
      psql(
        `SELECT count(*) FROM outbox_events WHERE org_id = '${id}' AND type LIKE 'tenancy.%'`,
      ),
    ).toBe('7');
    expect(
      psql(
        `SELECT payload->>'reason' FROM outbox_events WHERE org_id = '${id}' AND type = 'tenancy.member.removed'`,
      ),
    ).toBe('ACCOUNT_DELETED');
  });
  it('/health/ready is 200, the worker is healthy, and api/worker logs are clean JSON without errors', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    // Chạy sau ca identity (vitest chạy `it` theo thứ tự khai báo): `forbidden` đã có mọi giá trị ca đó sinh ra.
    expect(forbidden.length).toBeGreaterThan(1);
    assertCleanLogs(logsSince(since), forbidden);
  });
});
