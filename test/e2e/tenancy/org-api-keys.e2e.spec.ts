import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  adminKeys,
  apiKeyEligibleKeys,
  inOrgTx,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import {
  PayrollPermissionsModule,
  installPayrollPermission,
  permissionRowCount,
  removePayrollPermission,
} from './fixtures/payroll-permissions.js';

const MAX_TTL = 86_400;
const LIMIT = 3;
const STALE_SEC = 3600;

describe('org API keys: create, list, revoke (spec SP3 §10, §12; §18.3 K-1–K-3, K-8, K-12, K-15, K-16, B-22/B-24; Review Focus 2)', () => {
  let app: INestApplication;
  let full: string[];
  let rowsBefore: number;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const O = await seedP(o);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP(o);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP(o);
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const create = (
    p: SeededPrincipal,
    org: SeededOrg,
    body: Record<string, unknown>,
  ) => authed(app, p).post(`/v1/orgs/${org.orgId}/api-keys`).send(body);
  const ok = { name: 'ci', permissions: ['org.read'], expiresInSec: 3600 };

  beforeAll(async () => {
    rowsBefore = await permissionRowCount();
    await installPayrollPermission();
    app = await startTenancyApp({
      extraImports: [PayrollPermissionsModule],
      env: {
        TENANCY_ORG_API_KEY_MAX_TTL_SEC: String(MAX_TTL),
        TENANCY_MAX_ACTIVE_ORG_API_KEYS_PER_MEMBER: String(LIMIT),
        // K-15 nói về cấu hình cho phép đăng nhập chưa xác minh: chỉ khi đó route nhạy cảm mới là lớp chặn.
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      },
    });
    full = apiKeyEligibleKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await removePayrollPermission();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    expect(await permissionRowCount()).toBe(rowsBefore);
  });

  it('201: the key is returned once (no-store), hashed at rest, listed without it; event api_key.created in the same transaction', async () => {
    const c = await cast();
    const r = await create(c.A, c.org, { ...ok, permissions: full });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.location).toBe(
      `/v1/orgs/${c.org.orgId}/api-keys/${r.body.id}`,
    );
    expect(r.body.key).toMatch(/^oak_[A-Za-z0-9_-]{43}$/);
    expect(r.body).toMatchObject({
      name: 'ci',
      keyHint: r.body.key.slice(0, 10),
      permissions: full,
      createdByMemberId: c.a.memberPublicId,
      revokedAt: null,
    });
    // org_api_keys là FORCE RLS: đọc bằng app_user trong OrgScope. Lưu SHA-256 của key, không bao giờ key.
    const stored = await withAppClient((cl) =>
      inOrgTx(cl, c.org.orgId, () =>
        cl.query<{ h: string; row: string }>(
          `SELECT encode(token_hash, 'hex') AS h, k::text AS row FROM org_api_keys k WHERE public_id = $1`,
          [r.body.id],
        ),
      ),
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.h).toBe(
      createHash('sha256').update(r.body.key, 'utf8').digest('hex'),
    );
    expect(stored.rows[0]?.row).not.toContain(r.body.key);
    const list = await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/api-keys`);
    expect(list.body.data.map((k: { id: string }) => k.id)).toEqual([
      r.body.id,
    ]);
    expect(JSON.stringify(list.body)).not.toContain(r.body.key);
    const [ev] = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.api_key.created' AND aggregate_id = $1`,
      [r.body.id],
    );
    expect(ev?.payload).toEqual({
      apiKeyId: r.body.id,
      createdByMemberId: c.a.memberPublicId,
      permissions: full,
      expiresAt: r.body.expiresAt,
    });
  });
  it('K-1: a scope beyond the creator → 403 escalation_denied; K-2: an admin permission → 422 permission_not_api_key_eligible', async () => {
    const c = await cast();
    const k1 = await create(c.M, c.org, {
      ...ok,
      permissions: ['org.read', 'billing.read'],
    });
    expect([k1.status, k1.body.code]).toEqual([403, 'forbidden']); // MEMBER không có cửa api_keys.write_own (guard)
    const x = await seedCustomRole(c.org, {
      name: 'keys-no-billing',
      permissions: ['org.read', 'api_keys.write_own'],
    });
    const K = await seedP();
    await seedMemberInRole(c.org, x, { authUserId: K.authUserId });
    const beyond = await create(K, c.org, {
      ...ok,
      permissions: ['org.read', 'members.read'],
    });
    expect([beyond.status, beyond.body.code]).toEqual([
      403,
      'escalation_denied',
    ]);
    const k2 = await create(c.O, c.org, {
      ...ok,
      permissions: ['org.read', 'org.update'],
    });
    expect([k2.status, k2.body.code]).toEqual([
      422,
      'permission_not_api_key_eligible',
    ]);
    expect(k2.body.errors).toEqual([
      {
        path: 'permissions',
        code: 'permission_not_api_key_eligible',
        message: 'org.update',
      },
    ]);
  });
  it('K-12: a scope not closed under requires → 422 missing_dependencies naming the missing keys', async () => {
    const c = await cast();
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const withRequires = full.find(
      (k) => (merged.get(k)?.requires.length ?? 0) > 0,
    );
    if (!withRequires)
      throw new Error('fixture: no api-key-eligible permission has requires');
    const r = await create(c.O, c.org, { ...ok, permissions: [withRequires] });
    expect([r.status, r.body.code]).toEqual([422, 'missing_dependencies']);
    expect(r.body.errors).toEqual(
      (merged.get(withRequires)?.requires ?? []).map((key) => ({
        path: 'permissions',
        code: 'missing_dependency',
        message: key,
      })),
    );
  });
  it('Review Focus 2: scope duplicates, order, empty, unknown; TTL boundaries', async () => {
    const c = await cast();
    const dup = await create(c.O, c.org, {
      ...ok,
      permissions: ['roles.read', 'org.read', 'roles.read'],
    });
    expect([dup.status, dup.body.permissions]).toEqual([
      201,
      ['org.read', 'roles.read'],
    ]);
    expect(
      (await create(c.O, c.org, { ...ok, permissions: [] })).body.code,
    ).toBe('validation_failed');
    const unknown = await create(c.O, c.org, {
      ...ok,
      permissions: ['org.read', 'nope.read'],
    });
    expect([unknown.status, unknown.body.code]).toEqual([
      422,
      'unknown_permission',
    ]);
    const atMax = await create(c.O, c.org, { ...ok, expiresInSec: MAX_TTL });
    expect(atMax.status).toBe(201);
    const over = await create(c.O, c.org, {
      ...ok,
      expiresInSec: MAX_TTL + 1,
    });
    expect([over.status, over.body.code]).toEqual([422, 'ttl_out_of_range']);
    for (const bad of [0, -1, 1.5, '3600', null])
      expect(
        (await create(c.O, c.org, { ...ok, expiresInSec: bad })).body.code,
        String(bad),
      ).toBe('validation_failed');
    for (const name of ['', '   ', 'a'.repeat(65), 'two\nlines'])
      expect(
        (await create(c.O, c.org, { ...ok, name })).body.code,
        JSON.stringify(name),
      ).toBe('validation_failed');
  });
  it('T-11 (key): N concurrent creations over the per-member limit → exactly the limit succeed, the rest 422 api_keys_limit', async () => {
    const c = await cast();
    const rs = await Promise.all(
      Array.from({ length: LIMIT + 4 }, () => create(c.A, c.org, ok)),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(LIMIT);
    expect(
      rs.filter((r) => r.status !== 201).map((r) => [r.status, r.body.code]),
    ).toEqual(Array.from({ length: 4 }, () => [422, 'api_keys_limit']));
  });
  it('K-8: a member holding api_keys.write_all but not dominating the creator → 403 (rule 4: escalation_denied; an ADMIN creator: rule 2a first, owner_only)', async () => {
    const c = await cast();
    const w = await seedCustomRole(c.org, {
      name: 'revoker',
      // Đóng theo requires (write_all → api_keys.read, members.read), thấp hơn hẳn ADMIN.
      permissions: [
        'org.read',
        'members.read',
        'api_keys.read',
        'api_keys.write_all',
      ],
    });
    const R = await seedP();
    await seedMemberInRole(c.org, w, { authUserId: R.authUserId });
    // Người tạo không tương đương admin nhưng giữ quyền R không có (roles.read): đúng luật 4, không phải 2a.
    const k = await seedCustomRole(c.org, {
      name: 'key-maker',
      permissions: ['org.read', 'roles.read', 'api_keys.write_own'],
    });
    const K = await seedP();
    await seedMemberInRole(c.org, k, { authUserId: K.authUserId });
    const narrow = await create(K, c.org, ok);
    expect(narrow.status).toBe(201);
    const rule4 = await authed(app, R).delete(
      `/v1/orgs/${c.org.orgId}/api-keys/${narrow.body.id}`,
    );
    expect([rule4.status, rule4.body.code]).toEqual([403, 'escalation_denied']);
    const key = await create(c.A, c.org, ok);
    const r = await authed(app, R).delete(
      `/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`,
    );
    expect([r.status, r.body.code]).toEqual([403, 'owner_only']);
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`,
        )
      ).status,
    ).toBe(204);
    const evs = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.api_key.revoked' AND aggregate_id = $1`,
      [key.body.id],
    );
    expect(evs.map((e) => e.payload)).toEqual([
      { apiKeyId: key.body.id, reason: 'REVOKED' },
    ]);
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`,
        )
      ).status,
    ).toBe(204); // idempotent, không event thứ hai
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE type = 'tenancy.api_key.revoked' AND aggregate_id = $1`,
        [key.body.id],
      ),
    ).toHaveLength(1);
  });
  it('B-22/B-24 (keys): X (ADMIN ∪ payroll.read) revokes the key of an ADMIN, or of Bob holding V ≡ ADMIN → 403 owner_only', async () => {
    const c = await cast();
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const x = await seedCustomRole(c.org, {
      name: 'X',
      permissions: [...adminKeys(merged), 'payroll.read'],
    });
    const v = await seedCustomRole(c.org, {
      name: 'V',
      permissions: adminKeys(merged),
    });
    const X = await seedP();
    await seedMemberInRole(c.org, x, { authUserId: X.authUserId });
    const Bob = await seedP();
    await seedMemberInRole(c.org, v, { authUserId: Bob.authUserId });
    for (const holder of [c.A, Bob]) {
      const key = await create(holder, c.org, ok);
      expect(key.status).toBe(201);
      const r = await authed(app, X).delete(
        `/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`,
      );
      expect([r.status, r.body.code]).toEqual([403, 'owner_only']);
    }
  });
  it('K-15: creating a key with an unverified session when AUTH_REQUIRE_EMAIL_VERIFICATION=false → 403 email_not_verified', async () => {
    const c = await cast({ emailVerified: false });
    const r = await create(c.O, c.org, ok);
    expect([r.status, r.body.code]).toEqual([403, 'email_not_verified']);
  });
  it('K-16: A demoted to MEMBER still lists and revokes their own key with a stale session; …/mine/{other} → 404', async () => {
    const c = await cast();
    const mine = await create(c.A, c.org, ok);
    const others = await create(c.O, c.org, ok);
    expect([mine.status, others.status]).toEqual([201, 201]);
    // org_members là FORCE RLS: hạ role bằng app_user trong OrgScope (app_owner không có context thì không thấy dòng nào).
    const demoted = await withAppClient((cl) =>
      inOrgTx(cl, c.org.orgId, () =>
        cl.query(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [
          c.org.roles.MEMBER.id,
          c.a.memberId,
        ]),
      ),
    );
    expect(demoted.rowCount).toBe(1);
    await ownerQuery(
      `UPDATE auth.session SET created_at = now() - make_interval(secs => $2) WHERE token = $1`,
      [c.A.bearer, STALE_SEC],
    );
    // A (giờ là MEMBER) không còn cửa api_keys.read: danh sách chung bị chặn, `…/mine` thì không.
    expect(
      (await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/api-keys`)).status,
    ).toBe(403);
    const list = await authed(app, c.A).get(
      `/v1/orgs/${c.org.orgId}/api-keys/mine`,
    );
    expect(list.body.data.map((k: { id: string }) => k.id)).toEqual([
      mine.body.id,
    ]);
    expect(
      (
        await authed(app, c.A).delete(
          `/v1/orgs/${c.org.orgId}/api-keys/mine/${others.body.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await authed(app, c.A).delete(
          `/v1/orgs/${c.org.orgId}/api-keys/mine/${mine.body.id}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await authed(app, c.A).delete(
          `/v1/orgs/${c.org.orgId}/api-keys/mine/not-a-uuid`,
        )
      ).status,
    ).toBe(404);
  });
});
