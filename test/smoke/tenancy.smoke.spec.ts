import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { TEMPLATE_KEYS } from '../../src/modules/notifications/templates.js';
import { TENANCY_CATALOGUE } from '../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { Mailpit } from '../support/mailpit.js';
import {
  DEFINER_FUNCTIONS_3A,
  DEFINER_FUNCTIONS_3C,
  DEFINER_FUNCTIONS_3D,
  DEFINER_READ_TABLES_3A,
  DEFINER_TRIGGER_FUNCTIONS_3B,
  DEFINER_TRIGGER_FUNCTIONS_3D,
  TENANCY_TENANT_TABLES_3B,
  TENANCY_TENANT_TABLES_3C,
  TENANCY_TENANT_TABLES_3D,
} from '../support/tenancy-catalog.js';
import {
  Device,
  PASSWORD,
  staffDevice,
  verifiedDevice,
} from './smoke-devices.js';
import {
  assertCleanLogs,
  compose,
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
  it('the 3B schema migrated from dist: org_role_permissions FORCE RLS, closure trigger owned by tenancy_definer and deferred', () => {
    const forced = [...TENANCY_TENANT_TABLES_3B].sort();
    expect(
      psql(
        `SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${forced.map((t) => `'${t}'`).join(', ')})`,
      ),
    ).toBe(forced.map((t) => `${t}:true:true`).join(','));
    const fns = [...DEFINER_TRIGGER_FUNCTIONS_3B].sort();
    expect(
      psql(
        `SELECT string_agg(proname || ':' || pg_get_userbyid(proowner) || ':' || prosecdef::text, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${fns.map((f) => `'${f}'`).join(', ')})`,
      ),
    ).toBe(fns.map((f) => `${f}:tenancy_definer:true`).join(','));
    expect(
      psql(
        `SELECT condeferrable::text || ',' || condeferred::text FROM pg_constraint WHERE conname = 'org_role_permissions_closed_ck'`,
      ),
    ).toBe('true,true');
    expect(
      psql(
        `SELECT count(*) FROM pg_trigger WHERE tgname = 'org_role_permissions_guard' AND NOT tgisinternal`,
      ),
    ).toBe('1');
  });
  it('the acquisition schema of 3C migrated from dist: FORCE RLS on three tables, three definer functions owned by tenancy_definer, two template rows', () => {
    const tables = [...TENANCY_TENANT_TABLES_3C].sort();
    expect(
      psql(
        `SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${tables.map((t) => `'${t}'`).join(', ')})`,
      ),
    ).toBe(tables.map((t) => `${t}:true:true`).join(','));
    const fns = [...DEFINER_FUNCTIONS_3C].sort();
    expect(
      psql(
        `SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || has_function_privilege('app_user', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${fns.map((f) => `'${f}'`).join(', ')})`,
      ),
    ).toBe(fns.map((f) => `${f}:tenancy_definer:true:true`).join(','));
    expect(
      psql(
        `SELECT count(*) FROM email_templates WHERE key IN ('org-invitation', 'ownership-transfer-requested')`,
      ),
    ).toBe('2');
  });
  it('the delegation schema of 3D migrated from dist: FORCE RLS on four tables, definer functions and deferred definer triggers owned by tenancy_definer', () => {
    const tables = [...TENANCY_TENANT_TABLES_3D].sort();
    expect(
      psql(
        `SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${tables.map((t) => `'${t}'`).join(', ')})`,
      ),
    ).toBe(tables.map((t) => `${t}:true:true`).join(','));
    // app_user gọi được hai hàm tra cứu; hai hàm trigger chỉ app_owner có EXECUTE (CREATE TRIGGER đòi, lúc bắn không kiểm).
    const callable = new Set<string>(DEFINER_FUNCTIONS_3D);
    const fns = [
      ...DEFINER_FUNCTIONS_3D,
      ...DEFINER_TRIGGER_FUNCTIONS_3D,
    ].sort();
    expect(
      psql(
        `SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || has_function_privilege('app_user', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${fns.map((f) => `'${f}'`).join(', ')})`,
      ),
    ).toBe(
      fns.map((f) => `${f}:tenancy_definer:true:${callable.has(f)}`).join(','),
    );
    expect(
      psql(
        `SELECT string_agg(conname || ':' || condeferrable::text || ':' || condeferred::text, ',' ORDER BY conname) FROM pg_constraint WHERE conname IN ('org_api_key_permissions_closed_ck', 'org_members_no_active_support_grant', 'org_support_grant_permissions_closed_ck', 'org_support_grants_grantee_not_member')`,
      ),
    ).toBe(
      'org_api_key_permissions_closed_ck:true:true,org_members_no_active_support_grant:true:true,org_support_grant_permissions_closed_ck:true:true,org_support_grants_grantee_not_member:true:true',
    );
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
    // 3D (spec SP3 §9.7 (3)): admin chưa step-up bị gate TOTP chặn TRƯỚC kiểm dạng id.
    const r = await device.call('POST', '/api/auth/admin/remove-user', {
      body: { userId: id.toUpperCase() },
    });
    expect([
      r.status,
      z.object({ code: z.string() }).parse(await r.json()).code,
    ]).toEqual([403, 'second_factor_required']);
    // Nhân viên đã step-up: `422` đến từ kiểm dạng `userId` của hook (chạy sau gate), vốn không cần guard (review I1).
    const { device: staff } = await staffDevice(apiUrl, mail, forbidden);
    const upper = await staff.call('POST', '/api/auth/admin/remove-user', {
      body: { userId: id.toUpperCase() },
    });
    expect(upper.status).toBe(422);
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
    // Spec SP3 §5.3 (3D, N5-1): admin gọi `/admin/*` là nhân viên đã step-up TOTP thật.
    const { device: admin } = await staffDevice(apiUrl, mail, forbidden);
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
    // Spec SP3 §5.3 (3D, N5-1): admin gọi `/admin/*` là nhân viên đã step-up TOTP thật.
    const { device: admin } = await staffDevice(apiUrl, mail, forbidden);
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
  it('custom roles on the production image: create → assign to a seeded member → edit → delete refused 409 role_in_use → unassign → delete 204', async () => {
    const { device } = await verifiedDevice(apiUrl, mail, forbidden);
    const org = await device.call('POST', '/v1/orgs', {
      body: { name: 'Smoke 3B' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(org.status).toBe(201);
    const { id: orgId } = z.object({ id: z.uuid() }).parse(await org.json());
    // Member seed: một user đã xác thực khác, thêm thẳng bằng superuser (3B chưa có lời mời; 3C thêm đường API).
    const { email: memberEmail } = await verifiedDevice(
      apiUrl,
      mail,
      forbidden,
    );
    const authId = psql(
      `SELECT id FROM auth."user" WHERE email = '${memberEmail}'`,
    );
    const memberRole = psql(
      `SELECT id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'MEMBER'`,
    );
    psql(
      `INSERT INTO tenancy_users (auth_user_id) VALUES ('${authId}') ON CONFLICT (auth_user_id) DO NOTHING`,
    );
    psql(
      `INSERT INTO org_members (org_id, user_id, role_id) SELECT '${orgId}', id, ${memberRole} FROM tenancy_users WHERE auth_user_id = '${authId}'`,
    );
    // Đọc riêng: `-At` của psql in thêm dòng trạng thái lệnh sau `RETURNING`.
    const memberId = psql(
      `SELECT m.public_id FROM org_members m JOIN tenancy_users u ON u.id = m.user_id WHERE m.org_id = '${orgId}' AND u.auth_user_id = '${authId}'`,
    );
    const base = `/v1/orgs/${orgId}/roles`;
    const created = await device.call('POST', base, {
      body: { name: 'Support', permissions: ['org.read', 'members.read'] },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const { id: roleId } = z
      .object({ id: z.uuid() })
      .parse(await created.json());
    expect(
      (
        await device.call('PATCH', `/v1/orgs/${orgId}/members/${memberId}`, {
          body: { roleId },
          headers: { 'if-match': '*' },
        })
      ).status,
    ).toBe(200);
    const edited = await device.call('PATCH', `${base}/${roleId}`, {
      body: { permissions: ['org.read'] },
      headers: { 'if-match': '"1"' },
    });
    expect([edited.status, edited.headers.get('etag')]).toEqual([200, 'W/"2"']); // ETag yếu của `etagOf` (ADR 0007)
    const refused = await device.call('DELETE', `${base}/${roleId}`);
    expect(refused.status).toBe(409);
    expect(
      z.object({ code: z.string() }).parse(await refused.json()).code,
    ).toBe('role_in_use');
    const memberRolePublic = psql(
      `SELECT public_id FROM org_roles WHERE id = ${memberRole}`,
    );
    expect(
      (
        await device.call('PATCH', `/v1/orgs/${orgId}/members/${memberId}`, {
          body: { roleId: memberRolePublic },
          headers: { 'if-match': '*' },
        })
      ).status,
    ).toBe(200);
    expect((await device.call('DELETE', `${base}/${roleId}`)).status).toBe(204);
    // role.created, role.updated, role.deleted cùng transaction với từng thay đổi.
    expect(
      psql(
        `SELECT string_agg(type, ',' ORDER BY id) FROM outbox_events WHERE org_id = '${orgId}' AND type LIKE 'tenancy.role.%'`,
      ),
    ).toBe('tenancy.role.created,tenancy.role.updated,tenancy.role.deleted');
    expect(
      psql(
        `SELECT count(*) FROM org_role_permissions WHERE org_id = '${orgId}'`,
      ),
    ).toBe('0');
  });
  it('acquisition on the production image: invite → Mailpit #token= → preview → accept → change role → invite link join → ownership transfer accepted', async () => {
    const { device: owner } = await verifiedDevice(apiUrl, mail, forbidden);
    const { device: invitee, email: inviteeEmail } = await verifiedDevice(
      apiUrl,
      mail,
      forbidden,
    );
    const { device: joiner } = await verifiedDevice(apiUrl, mail, forbidden);
    const idem = () => ({ 'idempotency-key': `smoke-${randomUUID()}` });
    const Id = z.object({ id: z.uuid() });
    const org = await owner.call('POST', '/v1/orgs', {
      body: { name: 'Smoke 3C' },
      headers: idem(),
    });
    expect(org.status).toBe(201);
    const { id: orgId } = Id.parse(await org.json());
    const memberRole = psql(
      `SELECT public_id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'MEMBER'`,
    );
    const adminRole = psql(
      `SELECT public_id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'ADMIN'`,
    );

    const after = await mail.now();
    const invited = await owner.call('POST', `/v1/orgs/${orgId}/invitations`, {
      body: { email: inviteeEmail, roleId: memberRole },
      headers: idem(),
    });
    expect(invited.status).toBe(201);
    const msg = await mail.waitFor(inviteeEmail, {
      subject: /You're invited to join Smoke 3C/,
      after,
      timeoutMs: 60_000,
    });
    const token =
      /https:\/\/localhost\/invitations\/accept#token=([A-Za-z0-9_-]{43})/.exec(
        msg.Text,
      )?.[1];
    if (!token)
      throw new Error('no https accept link with #token= in the invitation');
    forbidden.push(token);
    const preview = await new Device(apiUrl).call(
      'POST',
      '/v1/invitations/preview',
      { body: { token }, cookie: false },
    );
    expect([
      preview.status,
      z.object({ roleName: z.string() }).parse(await preview.json()).roleName,
    ]).toEqual([200, 'Member']);
    const accepted = await invitee.call('POST', '/v1/invitations/accept', {
      body: { token },
      headers: idem(),
    });
    expect(accepted.status).toBe(201);
    const { id: memberId } = Id.parse(await accepted.json());
    expect(accepted.headers.get('location')).toBe(
      `/v1/orgs/${orgId}/members/${memberId}`,
    );

    expect(
      (
        await owner.call('PATCH', `/v1/orgs/${orgId}/members/${memberId}`, {
          body: { roleId: adminRole },
          headers: { 'if-match': '*' },
        })
      ).status,
    ).toBe(200);

    const link = await owner.call('POST', `/v1/orgs/${orgId}/invite-links`, {
      body: {
        roleId: memberRole,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect([link.status, link.headers.get('cache-control')]).toEqual([
      201,
      'no-store',
    ]);
    const linkToken =
      /^https:\/\/localhost\/join#token=([A-Za-z0-9_-]{43})$/.exec(
        z.object({ url: z.string() }).parse(await link.json()).url,
      )?.[1];
    if (!linkToken) throw new Error('invite link url without an https #token=');
    forbidden.push(linkToken);
    expect(
      (
        await joiner.call('POST', '/v1/invite-links/join', {
          body: { token: linkToken },
          headers: idem(),
        })
      ).status,
    ).toBe(201);

    const t = await owner.call(
      'POST',
      `/v1/orgs/${orgId}/ownership-transfers`,
      { body: { toMemberId: memberId, stepDownTo: 'ADMIN' }, headers: idem() },
    );
    expect(t.status).toBe(201);
    const { id: transferId } = Id.parse(await t.json());
    await mail.waitFor(inviteeEmail, {
      subject: /Ownership transfer requested for Smoke 3C/,
      after,
      timeoutMs: 60_000,
    });
    const ok = await invitee.call(
      'POST',
      `/v1/orgs/${orgId}/ownership-transfers/${transferId}/accept`,
      { body: {}, headers: idem() },
    );
    expect(ok.status).toBe(200);
    expect(
      psql(
        `SELECT r.system_key FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE m.public_id = '${memberId}'`,
      ),
    ).toBe('OWNER');
    // Event của cả luồng, cùng transaction với từng thay đổi.
    expect(
      psql(
        `SELECT string_agg(type, ',' ORDER BY id) FROM outbox_events WHERE org_id = '${orgId}' AND type ~ '^tenancy\\.(invitation|invite_link|ownership_transfer)\\.'`,
      ),
    ).toBe(
      'tenancy.invitation.created,tenancy.invitation.accepted,tenancy.invite_link.created,tenancy.ownership_transfer.requested,tenancy.ownership_transfer.accepted',
    );
    expect(
      psql(
        `SELECT count(*) FROM outbox_events WHERE org_id = '${orgId}' AND type = 'tenancy.member.added'`,
      ),
    ).toBe('3');
    expect(
      psql(
        `SELECT count(*) FROM org_invitations WHERE org_id = '${orgId}' AND token_hash IS NOT NULL`,
      ),
    ).toBe('0');
  });
  it('3D identity on the production image: staff step-up opens /admin/*, disable is forbidden, the reset command refuses without a TTY', async () => {
    const { device, email } = await staffDevice(apiUrl, mail, forbidden);
    expect(
      (await device.call('GET', '/api/auth/admin/list-users?limit=1')).status,
    ).toBe(200);
    const off = await device.call('POST', '/api/auth/two-factor/disable', {
      body: { password: PASSWORD },
    });
    expect([
      off.status,
      z.object({ code: z.string() }).parse(await off.json()).code,
    ]).toEqual([403, 'forbidden']);
    const id = psql(`SELECT id FROM auth."user" WHERE email = '${email}'`);
    let failure = '';
    try {
      compose(
        [
          'exec',
          '-T',
          'api',
          // Image distroless: node ở `/nodejs/bin/node` (ENTRYPOINT), không có trong PATH, không có pnpm.
          '/nodejs/bin/node',
          'dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js',
          '--user-id',
          id,
          '--ticket',
          'SMOKE-3D',
        ],
        { timeoutMs: 60_000 },
      );
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    expect(failure).toContain('needs an interactive terminal');
    expect(
      psql(
        `SELECT count(*) FROM auth.security_notice WHERE ticket = 'SMOKE-3D'`,
      ),
    ).toBe('0');
  });
  it('/health/ready is 200, the worker is healthy, and api/worker logs are clean JSON without errors', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    // Chạy sau ca identity (vitest chạy `it` theo thứ tự khai báo): `forbidden` đã có mọi giá trị ca đó sinh ra.
    expect(forbidden.length).toBeGreaterThan(1);
    assertCleanLogs(logsSince(since), forbidden);
  });
});
