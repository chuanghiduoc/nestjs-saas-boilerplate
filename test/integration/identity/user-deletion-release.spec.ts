import { Global, Logger, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  UserDeletionGuard,
  type UserDeletionCheck,
  type UserDeletionRelease,
} from '../../../src/modules/identity/index.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';

const guard = {
  check: vi.fn(async (_id: string): Promise<UserDeletionCheck> => ({
    kind: 'ALLOWED',
  })),
  release: vi.fn(async (_id: string): Promise<UserDeletionRelease> => ({
    kind: 'RELEASED',
  })),
};
@Global()
@Module({
  providers: [{ provide: UserDeletionGuard, useValue: guard }],
  exports: [UserDeletionGuard],
})
class FakeGuardModule {}

/** Trường `event` của các dòng log (tham số đầu của Logger). */
const errorEvents = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
  spy.mock.calls.flatMap((c) => {
    const f = c[0];
    return typeof f === 'object' && f !== null && 'event' in f ? [f.event] : [];
  });

const seeded: SeededPrincipal[] = [];
const seed = async (role?: string) => {
  // Spec SP3 §5.3 (3D, N5-1): admin gọi `/admin/*` là nhân viên có factor và dấu TOTP tươi.
  const p =
    role === 'admin'
      ? await seedStaffPrincipal()
      : await seedUserPrincipal({ role });
  seeded.push(p);
  return p;
};
const removeUser = (
  app: INestApplication,
  as: SeededPrincipal,
  userId: string,
) =>
  request(app.getHttpServer())
    .post('/api/auth/admin/remove-user')
    .set('authorization', `Bearer ${as.bearer}`)
    .send({ userId });

beforeAll(async () => {
  // FK fixture thay cho `tenancy_users_auth_user_fk` (bảng đó có từ Task 13; O-19 thật chạy ở Task 26).
  await ownerQuery(
    `CREATE TABLE fixture_user_refs (auth_user_id uuid REFERENCES auth."user"(id) ON DELETE RESTRICT)`,
  );
  await ownerQuery(
    `CREATE TABLE fixture_session_refs (session_id uuid REFERENCES auth.session(id) ON DELETE RESTRICT)`,
  );
});
afterAll(async () => {
  await ownerQuery('DROP TABLE IF EXISTS fixture_user_refs');
  await ownerQuery('DROP TABLE IF EXISTS fixture_session_refs');
  await deleteSeededPrincipals(seeded);
});

describe('T8 without a guard: the FK is the last line and answers 409, not 500', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => app?.close());
  afterEach(() => vi.restoreAllMocks());

  it('23001 on /admin/remove-user → 409 user_deletion_blocked with the runbook detail; no ERROR log', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    await ownerQuery(`INSERT INTO fixture_user_refs VALUES ($1)`, [
      victim.authUserId,
    ]);
    const error = vi.spyOn(Logger.prototype, 'error');
    const r = await removeUser(app, admin, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/runbook/);
    expect(errorEvents(error)).not.toContain('better_auth_unhandled_error');
    expect(errorEvents(error)).not.toContain('auth_endpoint_error');
    await ownerQuery(`DELETE FROM fixture_user_refs`);
  });
  it('INT3-4: 23001 on a path outside USER_DELETION_PATHS stays a logged 500', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    await ownerQuery(`INSERT INTO fixture_session_refs VALUES ($1)`, [
      victim.sessionId,
    ]);
    const error = vi.spyOn(Logger.prototype, 'error');
    const r = await request(app.getHttpServer())
      .post('/api/auth/admin/revoke-user-sessions')
      .set('authorization', `Bearer ${admin.bearer}`)
      .send({ userId: victim.authUserId });
    expect(r.status).toBe(500);
    expect(errorEvents(error)).toContain('better_auth_unhandled_error');
    await ownerQuery(`DELETE FROM fixture_session_refs`);
  });
});

describe('release in databaseHooks.user.delete.before (spec SP3 §9.6 step 3)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [FakeGuardModule] });
  });
  afterAll(async () => app?.close());
  afterEach(() => {
    guard.release.mockReset();
    guard.release.mockResolvedValue({ kind: 'RELEASED' });
  });

  it.each(['LAST_OWNER', 'MEMBERSHIP_CREATED'] as const)(
    'BLOCKED_RACE %s → 409; the user row stays but sessions and accounts are gone',
    async (reason) => {
      const [admin, victim] = [await seed('admin'), await seed()];
      // Principal seed không có account: thêm một account credential để kiểm Better Auth đã xoá nó trước hook.
      await ownerQuery(
        `INSERT INTO auth.account (account_id, provider_id, user_id, password, updated_at) VALUES ($1::text, 'credential', $1::uuid, 'seeded-hash', now())`,
        [victim.authUserId],
      );
      guard.release.mockResolvedValueOnce({ kind: 'BLOCKED_RACE', reason });
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const r = await removeUser(app, admin, victim.authUserId);
      expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
      expect(guard.release).toHaveBeenCalledWith(victim.authUserId);
      expect(
        warn.mock.calls.some((c) =>
          JSON.stringify(c[0]).includes('user_deletion_blocked_race'),
        ),
      ).toBe(true);
      const [left] = await ownerQuery<{ u: number; s: number; a: number }>(
        `SELECT (SELECT count(*)::int FROM auth."user" WHERE id = $1) AS u, (SELECT count(*)::int FROM auth.session WHERE user_id = $1) AS s, (SELECT count(*)::int FROM auth.account WHERE user_id = $1) AS a`,
        [victim.authUserId],
      );
      expect(left).toEqual({ u: 1, s: 0, a: 0 });
    },
  );
  it('RELEASED → the user is deleted', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    expect((await removeUser(app, admin, victim.authUserId)).status).toBe(200);
    expect(guard.release).toHaveBeenCalledWith(victim.authUserId);
  });
});
