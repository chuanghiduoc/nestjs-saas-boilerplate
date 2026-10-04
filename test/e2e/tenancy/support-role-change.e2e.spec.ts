import { Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NotifyOwnersOnGranted,
  NotifyOwnersOnRevoked,
  NotifyOwnersOnUsed,
  OwnerNotifier,
} from '../../../src/modules/tenancy/application/notify-owners.subscriber.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyPlatformRoleChangeListener } from '../../../src/modules/tenancy/infra/identity/platform-role-change.listener.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import { seedStaffStepUp } from '../../support/seed-staff-step-up.js';
import { enrolStaff, stepUp } from '../../support/staff.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedOrg,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RACE_ROUNDS = 50;

/** App e2e là api + worker events trong một process: subscriber của `forWorker` cần có mặt để event được giao. */
@Module({
  providers: [
    OwnerNotifier,
    NotifyOwnersOnGranted,
    NotifyOwnersOnUsed,
    NotifyOwnersOnRevoked,
  ],
})
class NotifyOwnersTestModule {}

describe('platform role writes revoke support grants; owners are told (spec SP3 §9.7 (6), "Thông báo owner"; §18.3 S-23; T-40)', () => {
  const mail = mailpitFromInfra();
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const enrolled: string[] = [];
  const orgs: SeededOrg[] = [];
  const ownerWithOrg = async () => {
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    return { O, org };
  };
  const enrolAdmin = async () => {
    const admin = await enrolStaff(app);
    enrolled.push(admin.userId);
    expect((await stepUp(admin)).status).toBe(200);
    return admin;
  };
  /**
   * org_support_grants là FORCE RLS và có nhiều org: đếm qua hàm definer `tenancy_grantee_open_grant_orgs` bằng app_user
   * (ownerQuery không có org context thì không thấy dòng nào).
   */
  const openGrantOrgsOf = (authUserId: string) =>
    withAppClient(
      async (c) =>
        (
          await c.query<{ org_id: string }>(
            `SELECT org_id::text FROM tenancy_grantee_open_grant_orgs((SELECT id FROM tenancy_users WHERE auth_user_id = $1))`,
            [authUserId],
          )
        ).rows,
    );

  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [NotifyOwnersTestModule] });
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

  it('S-23: /admin/set-role user on a staff with grants in two orgs → both revoked, two events GRANTEE_ROLE_CHANGED (system actor), owners mailed; promoting again does not revive them', async () => {
    const admin = await enrolAdmin();
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    for (const o of [a, b])
      await seedSupportGrant(o.org, {
        grantee: { authUserId: staff.authUserId },
        grantedByMemberId: o.org.owner.memberId,
        permissions: preset,
      });
    expect(await openGrantOrgsOf(staff.authUserId)).toHaveLength(2);
    const since = await mail.now();
    const r = await admin.client.request('post', '/api/auth/admin/set-role', {
      body: { userId: staff.authUserId, role: 'user' },
    });
    expect(r.status).toBe(200);
    expect(await openGrantOrgsOf(staff.authUserId)).toEqual([]);
    const evs = await ownerQuery<{
      payload: { reason: string };
      headers: Record<string, string>;
    }>(
      `SELECT payload, headers FROM outbox_events WHERE type = 'tenancy.support_access.revoked' AND org_id = ANY($1::uuid[])`,
      [[a.org.orgId, b.org.orgId]],
    );
    expect(
      evs.map((e) => [
        e.payload.reason,
        e.headers['actorType'],
        e.headers['actorId'],
      ]),
    ).toEqual([
      ['GRANTEE_ROLE_CHANGED', 'system', 'identity.platform-role-change'],
      ['GRANTEE_ROLE_CHANGED', 'system', 'identity.platform-role-change'],
    ]);
    for (const o of [a, b]) {
      const m = await mail.waitFor(o.O.email, {
        subject: /^Support access revoked/,
        after: since,
      });
      expect(m.Text).not.toContain(staff.email);
    }
    expect(
      (
        await admin.client.request('post', '/api/auth/admin/set-role', {
          body: { userId: staff.authUserId, role: 'admin' },
        })
      ).status,
    ).toBe(200);
    await seedStaffStepUp({ authUserId: staff.authUserId });
    expect(
      (await authed(app, staff).get(`/v1/orgs/${a.org.orgId}`)).status,
    ).toBe(404);
  });
  it('S-23: /admin/update-user with data.role revokes; without role keeps the grant; ["<id>"] array revokes; an uppercase id → 422 and nothing changes', async () => {
    const admin = await enrolAdmin();
    const grantTo = async () => {
      const staff = await seedStaffPrincipal();
      principals.push(staff);
      const o = await ownerWithOrg();
      await seedSupportGrant(o.org, {
        grantee: { authUserId: staff.authUserId },
        grantedByMemberId: o.org.owner.memberId,
        permissions: preset,
      });
      return staff;
    };
    const s1 = await grantTo();
    expect(
      (
        await admin.client.request('post', '/api/auth/admin/update-user', {
          body: { userId: s1.authUserId, data: { name: 'Renamed' } },
        })
      ).status,
    ).toBe(200);
    expect(await openGrantOrgsOf(s1.authUserId)).toHaveLength(1);
    expect(
      (
        await admin.client.request('post', '/api/auth/admin/update-user', {
          body: { userId: s1.authUserId, data: { role: 'user' } },
        })
      ).status,
    ).toBe(200);
    expect(await openGrantOrgsOf(s1.authUserId)).toEqual([]);
    const s2 = await grantTo();
    expect(
      (
        await admin.client.request('post', '/api/auth/admin/set-role', {
          body: { userId: [s2.authUserId], role: 'user' },
        })
      ).status,
    ).toBe(200);
    expect(await openGrantOrgsOf(s2.authUserId)).toEqual([]);
    const s3 = await grantTo();
    const upper = await admin.client.request(
      'post',
      '/api/auth/admin/set-role',
      { body: { userId: s3.authUserId.toUpperCase(), role: 'user' } },
    );
    expect([upper.status, upper.body.code]).toEqual([422, 'validation_failed']);
    expect(await openGrantOrgsOf(s3.authUserId)).toHaveLength(1);
  });
  it('S-23: the listener throws → 503 + ERROR platform_role_change_listener_failed; the role is written; the same request again revokes', async () => {
    const admin = await enrolAdmin();
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const o = await ownerWithOrg();
    await seedSupportGrant(o.org, {
      grantee: { authUserId: staff.authUserId },
      grantedByMemberId: o.org.owner.memberId,
      permissions: preset,
    });
    const listener = app.get(TenancyPlatformRoleChangeListener);
    const spy = vi
      .spyOn(listener, 'onPlatformRoleChanged')
      .mockRejectedValueOnce(new Error('fixture: listener down'));
    try {
      const first = await admin.client.request(
        'post',
        '/api/auth/admin/set-role',
        { body: { userId: staff.authUserId, role: 'user' } },
      );
      expect(first.status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await ownerQuery<{ role: string }>(
          `SELECT role FROM auth."user" WHERE id = $1`,
          [staff.authUserId],
        )
      )[0]?.role,
    ).toBe('user');
    expect(await openGrantOrgsOf(staff.authUserId)).toHaveLength(1);
    expect(
      (
        await admin.client.request('post', '/api/auth/admin/set-role', {
          body: { userId: staff.authUserId, role: 'user' },
        })
      ).status,
    ).toBe(200);
    expect(await openGrantOrgsOf(staff.authUserId)).toEqual([]);
  });
  it(`T-40: the role write commits while the grant waits on the org lock ×${RACE_ROUNDS} → the inserted grant serves nothing, the next role write revokes it`, async () => {
    const admin = await enrolAdmin();
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const staff = await seedStaffPrincipal();
      principals.push(staff);
      const o = await ownerWithOrg();
      // Thứ tự xen kẽ xấu nhất, ép tất định: lời cấp đã qua bước kiểm nhân viên (pool auth, trước khoá) và đang chờ khoá org;
      // set-role commit và listener chạy lúc đó (chưa có grant để thu hồi); khoá thả → grant được chèn cho một non-staff.
      const grant = await raceOnOrgLock(
        o.org.orgId,
        1,
        () =>
          authed(app, o.O)
            .post(`/v1/orgs/${o.org.orgId}/support-grants`)
            .set('idempotency-key', `k-${v7()}`)
            .send({
              staffUserId: staff.authUserId,
              expiresInSec: 900,
              reason: 'T-40',
            }),
        async () => {
          const demoted = await admin.client.request(
            'post',
            '/api/auth/admin/set-role',
            { body: { userId: staff.authUserId, role: 'user' } },
          );
          expect(demoted.status, `round ${i}`).toBe(200);
        },
      );
      expect(grant.status, `round ${i}`).toBe(201);
      expect(await openGrantOrgsOf(staff.authUserId), `round ${i}`).toEqual([
        { org_id: o.org.orgId },
      ]);
      // Cổng `isPlatformAdmin()` mỗi request của middleware (Task 22): grant lọt vẫn không dùng được.
      expect(
        (await authed(app, staff).get(`/v1/orgs/${o.org.orgId}`)).status,
        `round ${i}`,
      ).toBe(404);
      expect(
        (
          await admin.client.request('post', '/api/auth/admin/set-role', {
            body: { userId: staff.authUserId, role: 'admin' },
          })
        ).status,
      ).toBe(200);
      expect(await openGrantOrgsOf(staff.authUserId), `round ${i}`).toEqual([]);
    }
  }, 300_000);
  it('notify-owners: granted, used and revoked each mail every owner once (idempotency key per event and owner)', async () => {
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const o = await ownerWithOrg();
    const since = await mail.now();
    const g = await authed(app, o.O)
      .post(`/v1/orgs/${o.org.orgId}/support-grants`)
      .set('idempotency-key', `k-${v7()}`)
      .send({
        staffUserId: staff.authUserId,
        expiresInSec: 900,
        reason: 'SUP-77',
      });
    expect(g.status).toBe(201);
    expect(
      (await authed(app, staff).get(`/v1/orgs/${o.org.orgId}`)).status,
    ).toBe(200);
    expect(
      (
        await authed(app, o.O).delete(
          `/v1/orgs/${o.org.orgId}/support-grants/${g.body.id}`,
        )
      ).status,
    ).toBe(204);
    for (const subject of [
      /^Support access granted/,
      /^Support access used/,
      /^Support access revoked/,
    ]) {
      const m = await mail.waitFor(o.O.email, { subject, after: since });
      expect(m.Text).not.toContain('SUP-77');
      expect(m.Text).not.toContain(staff.email);
    }
    const keys = await ownerQuery<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM email_deliveries WHERE template = 'support-access-notice' AND idempotency_key LIKE $1`,
      [`%:${o.org.owner.memberPublicId}`],
    );
    expect(keys).toHaveLength(3);
  });
});
