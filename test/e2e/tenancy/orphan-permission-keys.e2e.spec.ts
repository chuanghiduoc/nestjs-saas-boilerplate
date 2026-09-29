import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedCustomRole,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';
import {
  installPayrollPermission,
  permissionRowCount,
  removePayrollPermission,
} from './fixtures/payroll-permissions.js';

/** Một lần mỗi file, trước khi app tạo meter (TenancyMetrics lấy meter từ provider toàn cục lúc khởi tạo). */
const otel = installOtelCapture();
const ORPHAN = 'payroll.read';
const ORPHAN_METRIC = 'tenancy_catalogue_orphan_keys';

const isOrphanWarn = (payload: unknown): boolean =>
  typeof payload === 'object' &&
  payload !== null &&
  'event' in payload &&
  payload.event === 'orphan_permission_ignored' &&
  'key' in payload &&
  payload.key === ORPHAN;

/**
 * R-X23 (+ R-X21 của 3A Task 20b): module có quyền `payroll.read` bị tắt — dòng `permissions` và dòng quyền của role tuỳ
 * biến ở lại DB, app không nạp catalogue `payroll`. Boot chỉ WARN; đường nóng bỏ qua key (không 500, không cấp gì, WARN +
 * metric một lần); sửa role gỡ được key; thêm lại → 422 unknown_permission.
 */
describe('orphan permission keys on custom roles (R-X23)', () => {
  let app: INestApplication;
  let permissionRowsBefore: number;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  /** Role `Pay` = {org.read, members.read, payroll.read} seed thẳng bằng SQL (API không cấp được key orphan); K giữ nó. */
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const pay = await seedCustomRole(org, {
      permissions: ['org.read', 'members.read', ORPHAN],
      name: `Pay ${v7()}`,
    });
    const K = await seedP();
    await seedMemberInRole(org, pay, { authUserId: K.authUserId });
    return { O, K, org, pay };
  };
  const roleUrl = (org: SeededOrg, role?: SeededRole) =>
    `/v1/orgs/${org.orgId}/roles${role ? `/${role.publicId}` : ''}`;
  const patch = (
    as: SeededPrincipal,
    org: SeededOrg,
    role: SeededRole,
    body: object,
  ) =>
    authed(app, as).patch(roleUrl(org, role)).set('if-match', '*').send(body);
  /** Key đã lưu của role, gồm cả orphan (đọc bằng app_user trong OrgScope, bỏ qua catalogue của app). */
  const storedKeys = (org: SeededOrg, role: SeededRole) =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, async () =>
        (
          await c.query<{ key: string }>(
            `SELECT p.key FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY p.key`,
            [role.id],
          )
        ).rows.map((r) => r.key),
      ),
    );

  beforeAll(async () => {
    permissionRowsBefore = await permissionRowCount();
    await installPayrollPermission();
    // KHÔNG có PayrollPermissionsModule: `payroll.read` chỉ có ở DB → orphan; boot WARN (R-X21), không từ chối.
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose(); // xoá dòng quyền trước (FK RESTRICT của permissions)
    await app?.close();
    await removePayrollPermission();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    expect(await permissionRowCount()).toBe(permissionRowsBefore);
  });

  it('hot path: the holder is not a 500, keeps its catalogue keys, gets nothing from the orphan; one WARN and one metric increment per process', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const metricBefore = (await otel.metric(ORPHAN_METRIC)) ?? 0; // boot của 20b có thể đã cộng cho cùng key
      const c = await cast();
      expect(
        (await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members`)).status,
      ).toBe(200);
      expect(
        (await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members/me`))
          .status,
      ).toBe(200);
      const role = await authed(app, c.O).get(roleUrl(c.org, c.pay));
      expect([role.status, role.body.permissions]).toEqual([
        200,
        ['members.read', 'org.read'],
      ]);
      expect(
        warn.mock.calls.filter(([payload]) => isOrphanWarn(payload)),
      ).toHaveLength(1);
      expect(await otel.metric(ORPHAN_METRIC)).toBe(metricBefore + 1);
    } finally {
      warn.mockRestore();
    }
  });
  it('a PATCH with permissions removes the orphan even when the granted set is unchanged → 200, version 2', async () => {
    const c = await cast();
    const r = await patch(c.O, c.org, c.pay, {
      permissions: ['org.read', 'members.read'],
    });
    expect([r.status, r.headers.etag, r.body.permissions]).toEqual([
      200,
      'W/"2"',
      ['members.read', 'org.read'],
    ]);
    expect(await storedKeys(c.org, c.pay)).toEqual([
      'members.read',
      'org.read',
    ]);
  });
  it('a PATCH without permissions (rename) leaves the stored orphan alone', async () => {
    const c = await cast();
    expect(
      (await patch(c.O, c.org, c.pay, { name: `Renamed ${v7()}` })).status,
    ).toBe(200);
    expect(await storedKeys(c.org, c.pay)).toEqual([
      'members.read',
      'org.read',
      ORPHAN,
    ]);
  });
  it('adding the orphan key (PATCH or POST) → 422 unknown_permission listing it; nothing stored changes', async () => {
    const c = await cast();
    const r = await patch(c.O, c.org, c.pay, {
      permissions: ['org.read', 'members.read', ORPHAN],
    });
    expect([
      r.status,
      r.body.code,
      r.body.errors.map((e: { message: string }) => e.message),
    ]).toEqual([422, 'unknown_permission', [ORPHAN]]);
    expect(await storedKeys(c.org, c.pay)).toEqual([
      'members.read',
      'org.read',
      ORPHAN,
    ]);
    const created = await authed(app, c.O)
      .post(roleUrl(c.org))
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: `New ${v7()}`, permissions: ['org.read', ORPHAN] });
    expect([created.status, created.body.code]).toEqual([
      422,
      'unknown_permission',
    ]);
  });
  it('an unused role that holds an orphan key deletes → 204 (its rows cascade)', async () => {
    const c = await cast();
    const spare = await seedCustomRole(c.org, {
      permissions: ['org.read', ORPHAN],
      name: `Spare ${v7()}`,
    });
    expect((await authed(app, c.O).delete(roleUrl(c.org, spare))).status).toBe(
      204,
    );
    expect(await storedKeys(c.org, spare)).toEqual([]);
  });
});
