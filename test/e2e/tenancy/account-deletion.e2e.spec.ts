import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UserDeletionService } from '../../../src/modules/tenancy/application/user-deletion.service.js';
import { TenancyTestHooks } from '../../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  deleteTenancyUsersOf,
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const PASSWORD = 'correct horse battery staple';
const CONCURRENT_RELEASES = 4;

/** Seam O-18/O-20/X-7: một hành động của test chạy trước khi `release` xử lý org kế tiếp. */
class ScriptedHooks extends TenancyTestHooks {
  onRelease: ((authUserId: string, orgId: string) => Promise<void>) | undefined;
  afterGuard(): Promise<void> {
    return Promise.resolve();
  }
  async beforeRelease(authUserId: string, orgId: string): Promise<void> {
    const fn = this.onRelease;
    this.onRelease = undefined;
    await fn?.(authUserId, orgId);
  }
}

describe('account deletion keeps every active organization owned (spec SP3 §9.6)', () => {
  const hooks = new ScriptedHooks();
  const mail = mailpitFromInfra();
  let app: INestApplication;
  let admin: SeededPrincipal;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const registeredIds: string[] = [];
  const client = () => new AuthClient(app.getHttpServer());
  const removeUser = (userId: unknown, as: SeededPrincipal = admin) =>
    authed(app, as)
      .post('/api/auth/admin/remove-user')
      .set('origin', 'http://localhost:3000')
      .send({ userId });
  const authRows = async (id: string) => ({
    user: (await ownerQuery('SELECT 1 FROM auth."user" WHERE id = $1', [id]))
      .length,
    accounts: (
      await ownerQuery('SELECT 1 FROM auth.account WHERE user_id = $1', [id])
    ).length,
    sessions: (
      await ownerQuery('SELECT 1 FROM auth.session WHERE user_id = $1', [id])
    ).length,
  });
  const tenancyUserRows = async (authUserId: string) =>
    (
      await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [
        authUserId,
      ])
    ).length;
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** User thật có mật khẩu (O-18 cần đăng nhập/đặt lại mật khẩu). */
  const registered = async () => {
    const email = `del-${randomUUID()}@example.test`;
    const c = client();
    const after = await mail.now();
    expect((await c.signUp(email, PASSWORD)).status).toBeLessThan(300);
    await c.verifyEmailFromMailpit(mail, email, after);
    const [row] = await ownerQuery<{ id: string }>(
      'SELECT id FROM auth."user" WHERE email = $1',
      [email],
    );
    if (!row) throw new Error('registered user not found');
    registeredIds.push(row.id);
    return { email, id: row.id };
  };
  beforeAll(async () => {
    app = await startTenancyApp({
      configure: (b) => b.overrideProvider(TenancyTestHooks).useValue(hooks),
    });
    admin = await seedP({ role: 'admin' });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await deleteTenancyUsersOf([
      ...principals.map((p) => p.authUserId),
      ...registeredIds,
    ]);
    await app?.close();
    await deleteSeededPrincipals(principals);
    await ownerQuery('DELETE FROM auth."user" WHERE id = ANY($1::uuid[])', [
      registeredIds,
    ]);
    vi.unstubAllEnvs();
  });

  it('O-2: deleting the sole owner of an active org → 409 user_deletion_blocked; user, account and session intact', async () => {
    const u = await seedP();
    orgs.push(await seedOrg({ owner: { authUserId: u.authUserId } }));
    const before = await authRows(u.authUserId);
    const r = await removeUser(u.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/only owner of 1 active organization/);
    expect(await authRows(u.authUserId)).toEqual(before);
  });
  it.each([
    ['as an array', (id: string) => [id], 409, 'user_deletion_blocked'],
    ['upper-case', (id: string) => id.toUpperCase(), 422, 'validation_failed'],
    ['braced', (id: string) => `{${id}}`, 422, 'validation_failed'],
    [
      'without hyphens',
      (id: string) => id.replaceAll('-', ''),
      422,
      'validation_failed',
    ],
  ])(
    'O-2b: the target id %s → %i %s, credentials intact',
    async (_n, shape, status, code) => {
      const u = await seedP();
      orgs.push(await seedOrg({ owner: { authUserId: u.authUserId } }));
      const before = await authRows(u.authUserId);
      const r = await removeUser(shape(u.authUserId));
      expect([r.status, r.body.code]).toEqual([status, code]);
      expect(await authRows(u.authUserId)).toEqual(before);
    },
  );
  it("O-2b: the admin's own id in upper case → 422; the admin keeps its session and account", async () => {
    const a = await seedP({ role: 'admin' });
    const before = await authRows(a.authUserId);
    const r = await removeUser(a.authUserId.toUpperCase(), a);
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
    expect(await authRows(a.authUserId)).toEqual(before);
  });
  it('O-17: a non-admin calling /admin/remove-user for a last owner gets the Better Auth permission error, not 409', async () => {
    const u = await seedP();
    const outsider = await seedP();
    orgs.push(await seedOrg({ owner: { authUserId: u.authUserId } }));
    const r = await removeUser(u.authUserId, outsider);
    expect(r.status).toBe(403);
    expect(r.body.code).not.toBe('user_deletion_blocked');
  });
  it('O-11: the sole owner of a soft-deleted org may be deleted; the membership is removed with an ACCOUNT_DELETED event', async () => {
    const u = await seedP();
    const org = await seedOrg({ owner: { authUserId: u.authUserId } });
    orgs.push(org);
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
    expect((await removeUser(u.authUserId)).status).toBe(200);
    expect(
      await ownerQuery('SELECT 1 FROM auth."user" WHERE id = $1', [
        u.authUserId,
      ]),
    ).toEqual([]);
    expect(
      await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [
        u.authUserId,
      ]),
    ).toEqual([]);
    const [evt] = await ownerQuery<{
      payload: { reason: string };
      headers: { actorType: string; actorId: string };
    }>(
      `SELECT payload, headers FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.removed'`,
      [org.orgId],
    );
    expect([
      evt?.payload.reason,
      evt?.headers.actorType,
      evt?.headers.actorId,
    ]).toEqual(['ACCOUNT_DELETED', 'system', 'identity.user-deletion']);
  });
  it('a member (not an owner) is deleted cleanly; organizations it created lose created_by_user_id', async () => {
    const owner = await seedP();
    const creator = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const m = await seedMember(org, 'MEMBER', {
      authUserId: creator.authUserId,
    });
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          'UPDATE organizations SET created_by_user_id = $1 WHERE id = $2',
          [m.userId, org.orgId],
        ),
      ),
    );
    expect((await removeUser(creator.authUserId)).status).toBe(200);
    const row = await withAppClient((c) =>
      inOrgTx(
        c,
        org.orgId,
        async () =>
          (
            await c.query<{ created_by_user_id: string | null }>(
              'SELECT created_by_user_id FROM organizations WHERE id = $1',
              [org.orgId],
            )
          ).rows[0],
      ),
    );
    expect(row?.created_by_user_id).toBeNull();
  });
  it('a user who never touched tenancy: release is a no-op (RELEASED, no tenancy_users row created) and the account is deleted', async () => {
    const u = await seedP();
    expect(await tenancyUserRows(u.authUserId)).toBe(0);
    expect(await app.get(UserDeletionService).release(u.authUserId)).toEqual({
      kind: 'RELEASED',
    });
    expect(await tenancyUserRows(u.authUserId)).toBe(0);
    expect((await removeUser(u.authUserId)).status).toBe(200);
    expect(await authRows(u.authUserId)).toEqual({
      user: 0,
      accounts: 0,
      sessions: 0,
    });
    expect(await tenancyUserRows(u.authUserId)).toBe(0);
  });
  it(`${CONCURRENT_RELEASES} concurrent releases of one user: all RELEASED, one ACCOUNT_DELETED event per org, no tenancy row left`, async () => {
    const u = await seedP();
    const owner = await seedP();
    const a = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const b = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(a, b);
    await seedMember(a, 'MEMBER', { authUserId: u.authUserId });
    await seedMember(b, 'ADMIN', { authUserId: u.authUserId });
    const svc = app.get(UserDeletionService);
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_RELEASES }, () =>
        svc.release(u.authUserId),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: CONCURRENT_RELEASES }, () => ({ kind: 'RELEASED' })),
    );
    expect(await tenancyUserRows(u.authUserId)).toBe(0);
    for (const org of [a, b]) {
      const events = await ownerQuery<{ reason: string }>(
        `SELECT payload->>'reason' AS reason FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.removed'`,
        [org.orgId],
      );
      expect(events).toEqual([{ reason: 'ACCOUNT_DELETED' }]);
    }
  });
  it('O-20: a membership created during release (23001 org_members_user_fk) → 409, not 500', async () => {
    const u = await seedP();
    const owner = await seedP();
    const a = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const b = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(a, b);
    await seedMember(a, 'MEMBER', { authUserId: u.authUserId });
    hooks.onRelease = async () => {
      await seedMember(b, 'MEMBER', { authUserId: u.authUserId });
    };
    const r = await removeUser(u.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/runbook/i);
  });
  it('O-18: owners A, B; A passes the preflight; B leaves before release → 409; A cannot sign in; reset-password restores A; A promotes M; deleting A then succeeds', async () => {
    const a = await registered();
    const b = await seedP();
    const m = await seedP();
    const org = await seedOrg({ owner: { authUserId: a.id } });
    orgs.push(org);
    const bm = await seedMember(org, 'OWNER', { authUserId: b.authUserId });
    const mm = await seedMember(org, 'MEMBER', { authUserId: m.authUserId });
    hooks.onRelease = () =>
      withAppClient((c) =>
        inOrgTx(
          c,
          org.orgId,
          async () =>
            void (await c.query('DELETE FROM org_members WHERE id = $1', [
              bm.memberId,
            ])),
        ),
      );
    const first = await removeUser(a.id);
    expect([first.status, first.body.code]).toEqual([
      409,
      'user_deletion_blocked',
    ]);
    const owners = await withAppClient((c) =>
      inOrgTx(
        c,
        org.orgId,
        async () =>
          (
            await c.query<{ id: string }>(
              `SELECT m.id::text AS id FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`,
            )
          ).rows,
      ),
    );
    expect(owners.map((o) => o.id)).toEqual([org.owner.memberId]);
    expect((await client().signIn(a.email, PASSWORD)).status).toBe(401);
    // Runbook: quên mật khẩu tạo lại account credential (Better Auth 1.7.6).
    const started = await mail.now();
    await client().request('post', '/api/auth/request-password-reset', {
      body: { email: a.email },
      cookie: false,
    });
    const msg = await mail.waitFor(a.email, {
      subject: /Reset your password/,
      after: started,
    });
    const token = /\/reset-password\/([^?\s"<>]+)/.exec(msg.Text)?.[1];
    expect(
      (
        await client().request('post', '/api/auth/reset-password', {
          body: { token, newPassword: 'a brand new passphrase' },
          cookie: false,
        })
      ).status,
    ).toBe(200);
    const aClient = client();
    expect(
      (await aClient.signIn(a.email, 'a brand new passphrase')).status,
    ).toBe(200);
    const promote = await aClient.request(
      'patch',
      `/v1/orgs/${org.orgId}/members/${mm.memberPublicId}`,
      {
        body: { roleId: org.roles.OWNER.publicId },
        headers: { 'if-match': '*' },
      },
    );
    expect(promote.status).toBe(200);
    expect((await removeUser(a.id)).status).toBe(200);
  });
  it('X-7 / T-26: the org is purged while release walks it → the walk skips it and the deletion completes', async () => {
    const u = await seedP();
    const org = await seedOrg({
      owner: { authUserId: (await seedP()).authUserId },
    });
    await seedMember(org, 'MEMBER', { authUserId: u.authUserId });
    hooks.onRelease = async (_id, orgId) => {
      if (orgId === org.orgId) await org.dispose();
    };
    expect((await removeUser(u.authUserId)).status).toBe(200);
    expect(
      await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [
        u.authUserId,
      ]),
    ).toEqual([]);
  });
});
