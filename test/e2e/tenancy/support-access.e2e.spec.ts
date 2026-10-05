import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { SupportGrantRepository } from '../../../src/modules/tenancy/ports/support-grant-repository.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  seedStaffFactor,
  seedStepUpMark,
} from '../../support/seed-staff-step-up.js';
import { enrolStaff, stepUp } from '../../support/staff.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const STEP_UP_MAX_AGE = 600;
type Pool = { query: (...a: unknown[]) => Promise<unknown> };

describe('support access through a grant (spec SP3 §7.1 bước 3.7, 3.10; §9.7; §18.3 S-4–S-12, S-16, S-17)', () => {
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const enrolled: string[] = [];
  const orgs: SeededOrg[] = [];
  const as = (p: SeededPrincipal) => authed(app, p);
  /** Org + grant do owner cấp cho `staff` (auth user id). */
  const granted = async (
    staffAuthUserId: string,
    o: { revoked?: boolean; expiresInSec?: number } = {},
  ) => {
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const g = await seedSupportGrant(org, {
      grantee: { authUserId: staffAuthUserId },
      grantedByMemberId: org.owner.memberId,
      permissions: preset,
      ...o,
    });
    return { O, org, g };
  };
  const staffP = async (o?: Parameters<typeof seedStaffPrincipal>[0]) => {
    const p = await seedStaffPrincipal(o);
    principals.push(p);
    return p;
  };
  /** FORCE RLS: ghi bảng tenant bằng app_user trong OrgScope và khẳng định đúng một dòng bị chạm. */
  const inOrgWrite = async (org: SeededOrg, sql: string, params: unknown[]) => {
    const r = await withAppClient((c) =>
      inOrgTx(c, org.orgId, () => c.query(sql, params)),
    );
    expect(r.rowCount).toBe(1);
  };
  /** Đếm câu chạm `auth.session_second_factor` trên pool auth (S-16, S-17). */
  const countMarkQueries = async (fn: () => Promise<unknown>) => {
    const pool = app.get<Pool>(AUTH_POOL);
    const spy = vi.spyOn(pool, 'query');
    try {
      await fn();
      return spy.mock.calls.filter((c) =>
        String(c[0]).includes('session_second_factor'),
      ).length;
    } finally {
      spy.mockRestore();
    }
  };

  beforeAll(async () => {
    app = await startTenancyApp({
      env: { TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC: String(STEP_UP_MAX_AGE) },
    });
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    for (const id of enrolled) {
      await ownerQuery(`DELETE FROM tenancy_users WHERE auth_user_id = $1`, [
        id,
      ]);
      await ownerQuery(`DELETE FROM auth."user" WHERE id = $1`, [id]);
    }
    vi.unstubAllEnvs();
  });

  it('S-5: a stepped-up staff reads routes of the preset → 200 via SUPPORT_GRANT; S-4: role, member-write, key and grant routes → 403', async () => {
    const s = await staffP();
    const { org } = await granted(s.authUserId);
    const base = `/v1/orgs/${org.orgId}`;
    for (const url of [
      base,
      `${base}/members`,
      `${base}/roles`,
      `${base}/invitations`,
    ])
      expect((await as(s).get(url)).status, url).toBe(200);
    expect((await as(s).get(`${base}/support-grants`)).status).toBe(403);
    expect((await as(s).get(`${base}/api-keys`)).status).toBe(403);
    expect((await as(s).get(`${base}/api-keys/mine`)).status).toBe(403); // @OrgMemberOnly
    expect(
      (
        await as(s)
          .post(`${base}/roles`)
          .set('idempotency-key', `k-${v7()}`)
          .send({ name: 'x', permissions: ['org.read'] })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(s)
          .post(`${base}/api-keys`)
          .send({ name: 'x', permissions: ['org.read'], expiresInSec: 60 })
      ).status,
    ).toBe(403);
    expect((await as(s).delete(`${base}/members/me`)).status).toBe(403);
  });
  it('S-6: after expiry or revocation → 404 at the next request; S-9: another org → 404; S-7: the granting owner demoted → 404', async () => {
    const s = await staffP();
    const expired = await granted(s.authUserId, { expiresInSec: -1 });
    expect((await as(s).get(`/v1/orgs/${expired.org.orgId}`)).status).toBe(404);
    const live = await granted(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${live.org.orgId}`)).status).toBe(200);
    await inOrgWrite(
      live.org,
      `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE public_id = $1`,
      [live.g.publicId],
    );
    expect((await as(s).get(`/v1/orgs/${live.org.orgId}`)).status).toBe(404);
    const other = await granted((await staffP()).authUserId);
    expect((await as(s).get(`/v1/orgs/${other.org.orgId}`)).status).toBe(404);
    const s7 = await granted(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${s7.org.orgId}`)).status).toBe(200);
    const O2 = await seedUserPrincipal();
    principals.push(O2);
    await seedMember(s7.org, 'OWNER', { authUserId: O2.authUserId });
    await inOrgWrite(
      s7.org,
      `UPDATE org_members SET role_id = $1 WHERE id = $2`,
      [s7.org.roles.ADMIN.id, s7.org.owner.memberId],
    );
    expect((await as(s).get(`/v1/orgs/${s7.org.orgId}`)).status).toBe(404);
  });
  it('S-12: a grant without a valid mark → 403 second_factor_required (never 404) on every branch; the same session after step-up → 200', async () => {
    const s = await enrolStaff(app);
    enrolled.push(s.userId);
    const { org } = await granted(s.userId);
    const url = `/v1/orgs/${org.orgId}/members`;
    // Đăng nhập mật khẩu + TOTP không ghi dấu.
    const signedIn = await s.client.request('get', url);
    expect([signedIn.status, signedIn.body.code]).toEqual([
      403,
      'second_factor_required',
    ]);
    expect((await stepUp(s)).status).toBe(200);
    expect((await s.client.request('get', url)).status).toBe(200);
    // Dấu cũ hơn TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC.
    await ownerQuery(
      `UPDATE auth.session_second_factor SET verified_at = now() - make_interval(secs => $2) WHERE session_id IN (SELECT id FROM auth.session WHERE user_id = $1)`,
      [s.userId, STEP_UP_MAX_AGE + 1],
    );
    expect((await s.client.request('get', url)).body.code).toBe(
      'second_factor_required',
    );
    // Dấu của session KHÁC của cùng nhân viên.
    const other = await staffP({ mark: false });
    const f = await seedStaffFactor(other.authUserId);
    const second = await granted(other.authUserId);
    const [otherSession] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, created_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now(), now()) RETURNING id`,
      [`t-${v7()}`, other.authUserId],
    );
    if (!otherSession) throw new Error('second session not inserted');
    await seedStepUpMark({ sessionId: otherSession.id, factorId: f });
    expect(
      (await as(other).get(`/v1/orgs/${second.org.orgId}`)).body.code,
    ).toBe('second_factor_required');
    // Dấu bằng backup code mở được grant (N5-3).
    const backup = await enrolStaff(app);
    enrolled.push(backup.userId);
    const third = await granted(backup.userId);
    const code = backup.backupCodes[0];
    if (!code) throw new Error('enrolStaff returned no backup code');
    expect((await stepUp(backup, { backupCode: code })).status).toBe(200);
    expect(
      (await backup.client.request('get', `/v1/orgs/${third.org.orgId}`))
        .status,
    ).toBe(200);
  });
  it('S-10/T-35: removing the factor drops the mark (CASCADE); a new factor without a step-up → still 403; step-up with it → 200', async () => {
    const s = await staffP();
    const { org } = await granted(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [
      s.authUserId,
    ]);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).body.code).toBe(
      'second_factor_required',
    );
    const f = await seedStaffFactor(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).body.code).toBe(
      'second_factor_required',
    );
    await seedStepUpMark({ sessionId: s.sessionId, factorId: f });
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
  });
  it('S-11/T-15: two parallel first requests → first_used_at once, exactly one support_access.used', async () => {
    const s = await staffP();
    const { org, g } = await granted(s.authUserId);
    const rs = await Promise.all([
      as(s).get(`/v1/orgs/${org.orgId}`),
      as(s).get(`/v1/orgs/${org.orgId}/members`),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const used = () =>
      ownerQuery(
        `SELECT 1 FROM outbox_events WHERE type = 'tenancy.support_access.used' AND aggregate_id = $1`,
        [g.publicId],
      );
    expect(await used()).toHaveLength(1);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
    expect(await used()).toHaveLength(1);
  });
  it('review m1: the owner revokes between the read and the first-use write → 404 like an absent grant, no used event, first_used_at stays NULL', async () => {
    const s = await staffP();
    const { org, g } = await granted(s.authUserId);
    const repo = app.get(SupportGrantRepository);
    const realMark = repo.markFirstUse.bind(repo);
    // Seam: lần ghi đầu chạy SAU khi transaction đọc của middleware đã thấy grant mở; owner thu hồi (commit) đúng lúc đó.
    const spy = vi
      .spyOn(repo, 'markFirstUse')
      .mockImplementationOnce(async (id) => {
        await inOrgWrite(
          org,
          'UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1',
          [g.id],
        );
        return realMark(id);
      });
    try {
      const r = await as(s).get(`/v1/orgs/${org.orgId}`);
      expect([r.status, r.body.code]).toEqual([404, 'not_found']);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    const [row] = (
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query<{ first_used_at: Date | null; revoked_at: Date | null }>(
            'SELECT first_used_at, revoked_at FROM org_support_grants WHERE id = $1',
            [g.id],
          ),
        ),
      )
    ).rows;
    expect(row?.first_used_at).toBeNull();
    expect(row?.revoked_at).toBeInstanceOf(Date);
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE type = 'tenancy.support_access.used' AND aggregate_id = $1`,
        [g.publicId],
      ),
    ).toHaveLength(0);
  });
  it('S-16: a non-staff session, a member, and staff without a grant never query the mark table; S-17: a served grant queries it exactly once', async () => {
    const plain = await seedUserPrincipal();
    principals.push(plain);
    const s = await staffP();
    const { O, org } = await granted(s.authUserId);
    const noGrant = await staffP();
    expect(
      await countMarkQueries(() => as(plain).get(`/v1/orgs/${org.orgId}`)),
    ).toBe(0);
    expect(
      await countMarkQueries(() => as(O).get(`/v1/orgs/${org.orgId}`)),
    ).toBe(0);
    expect(
      await countMarkQueries(() => as(noGrant).get(`/v1/orgs/${org.orgId}`)),
    ).toBe(0);
    expect(
      await countMarkQueries(() => as(s).get(`/v1/orgs/${org.orgId}`)),
    ).toBe(1);
  });
  it('S-17: the staff session revoked between authentication and the support branch → 403, never 500', async () => {
    const s = await staffP();
    const { org } = await granted(s.authUserId);
    const pool = app.get<Pool>(AUTH_POOL);
    const real = pool.query.bind(pool);
    const spy = vi
      .spyOn(pool, 'query')
      .mockImplementation(async (...args: unknown[]) => {
        if (String(args[0]).includes('session_second_factor'))
          await ownerQuery(`DELETE FROM auth.session WHERE id = $1`, [
            s.sessionId,
          ]);
        return real(...args);
      });
    try {
      const r = await as(s).get(`/v1/orgs/${org.orgId}`);
      expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
    } finally {
      spy.mockRestore();
    }
  });
  it('T-40 (middleware half): an open grant whose grantee is no longer platform staff serves nothing — plain 404, no mark query', async () => {
    const s = await staffP();
    const { org } = await granted(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
    // Role ghi bằng SQL: không listener nào thu hồi grant, nên chỉ cổng `isPlatformAdmin()` mỗi request còn chặn.
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id = $1`, [
      s.authUserId,
    ]);
    let r: request.Response | undefined;
    expect(
      await countMarkQueries(async () => {
        r = await as(s).get(`/v1/orgs/${org.orgId}`);
      }),
    ).toBe(0);
    expect([r?.status, r?.body.code]).toEqual([404, 'not_found']);
  });
  it('Review Focus 3 (pre-check): a staff member who is a member is served as a member, with no step-up asked', async () => {
    const s = await staffP({ mark: false });
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    await seedMember(org, 'MEMBER', { authUserId: s.authUserId });
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
  });
});

/** App riêng: hai app không cùng chạy trong một process (registry context của config). */
describe('support access with TENANCY_SUPPORT_GRANTS=off', () => {
  it('a stepped-up staff member holding a grant gets the plain 404', async () => {
    const off = await startTenancyApp({
      env: { TENANCY_SUPPORT_GRANTS: 'off' },
    });
    const O = await seedUserPrincipal();
    const s = await seedStaffPrincipal();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    try {
      await seedSupportGrant(org, {
        grantee: { authUserId: s.authUserId },
        grantedByMemberId: org.owner.memberId,
        permissions: supportPresetKeys(
          off.get(PermissionCatalogueRegistry).merged(),
        ),
      });
      const r = await request(off.getHttpServer())
        .get(`/v1/orgs/${org.orgId}`)
        .set('authorization', `Bearer ${s.bearer}`);
      expect([r.status, r.body.code]).toEqual([404, 'not_found']);
    } finally {
      await org.dispose();
      await off.close();
      await deleteSeededPrincipals([O, s]);
    }
  });
});
