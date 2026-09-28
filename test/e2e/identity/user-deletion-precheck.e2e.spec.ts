import { ConnectionException } from '@mikro-orm/core';
import { Global, Module, type INestApplication } from '@nestjs/common';
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

const credentialsLeft = async (id: string) =>
  (
    await ownerQuery<{ u: number; s: number }>(
      `SELECT (SELECT count(*)::int FROM auth."user" WHERE id = $1) AS u, (SELECT count(*)::int FROM auth.session WHERE user_id = $1) AS s`,
      [id],
    )
  )[0];
const everythingLeft = async (id: string) =>
  (
    await ownerQuery<{ u: number; s: number; a: number }>(
      `SELECT (SELECT count(*)::int FROM auth."user" WHERE id = $1) AS u,
              (SELECT count(*)::int FROM auth.session WHERE user_id = $1) AS s,
              (SELECT count(*)::int FROM auth.account WHERE user_id = $1) AS a`,
      [id],
    )
  )[0];
const addAccount = (userId: string) =>
  ownerQuery(
    `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, 'corp', $2, now())`,
    [`sub-${userId}`, userId],
  );

describe('user deletion pre-check in hooks.before (spec SP3 §9.6, O-2, O-2b, O-17, T5)', () => {
  let app: INestApplication;
  const seeded: SeededPrincipal[] = [];
  const seed = async (role?: string) => {
    const p = await seedUserPrincipal({ role });
    seeded.push(p);
    return p;
  };
  const removeUser = (as: SeededPrincipal, userId: unknown) =>
    request(app.getHttpServer())
      .post('/api/auth/admin/remove-user')
      .set('authorization', `Bearer ${as.bearer}`)
      .send({ userId });
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [FakeGuardModule] });
  });
  afterEach(() => {
    guard.check.mockClear();
    guard.release.mockClear();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
  });

  it('BLOCKED_LAST_OWNER → 409 user_deletion_blocked with the org count; nothing is deleted', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    guard.check.mockResolvedValueOnce({
      kind: 'BLOCKED_LAST_OWNER',
      orgCount: 2,
    });
    const r = await removeUser(admin, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/2 active organization/);
    expect(guard.check).toHaveBeenCalledWith(victim.authUserId);
    expect(guard.release).not.toHaveBeenCalled();
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it('O-2b: userId sent as ["<id>"] is read as the plugin coerces it and still blocked', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    guard.check.mockResolvedValueOnce({
      kind: 'BLOCKED_LAST_OWNER',
      orgCount: 1,
    });
    const r = await removeUser(admin, [victim.authUserId]);
    expect(r.status).toBe(409);
    expect(guard.check).toHaveBeenCalledWith(victim.authUserId);
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it.each([
    ['an uppercase id', (id: string) => id.toUpperCase()],
    ['a braced id', (id: string) => `{${id}}`],
    ['an id without hyphens', (id: string) => id.replaceAll('-', '')],
  ])(
    'O-2b: %s → 422 validation_failed before any guard or plugin runs',
    async (_n, shape) => {
      const [admin, victim] = [await seed('admin'), await seed()];
      const r = await removeUser(admin, shape(victim.authUserId));
      expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
      expect(guard.check).not.toHaveBeenCalled();
      expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 1, s: 1 });
    },
  );
  it("O-2b: the admin's own id in uppercase → 422, the admin keeps its session", async () => {
    const admin = await seed('admin');
    const r = await removeUser(admin, admin.authUserId.toUpperCase());
    expect(r.status).toBe(422);
    expect(await credentialsLeft(admin.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it('O-17: a non-admin gets the plugin permission error, never 409 (no last-owner oracle)', async () => {
    const [user, victim] = [await seed(), await seed()];
    const r = await removeUser(user, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(guard.check).not.toHaveBeenCalled();
  });
  it('a guard that throws (bug) → 500 internal_error; user, sessions and accounts all survive', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    await addAccount(victim.authUserId);
    guard.check.mockRejectedValueOnce(new Error('guard bug'));
    const r = await removeUser(admin, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([500, 'internal_error']);
    expect(guard.check).toHaveBeenCalledWith(victim.authUserId);
    expect(await everythingLeft(victim.authUserId)).toEqual({
      u: 1,
      s: 1,
      a: 1,
    });
  });
  it('a guard whose database is down → 503 service_unavailable with Retry-After (spec §5.5 rule 4); nothing is deleted', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    await addAccount(victim.authUserId);
    // What core `Db` (MikroORM) throws when the app database refuses connections.
    guard.check.mockRejectedValueOnce(
      new ConnectionException(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        }),
      ),
    );
    const r = await removeUser(admin, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(await everythingLeft(victim.authUserId)).toEqual({
      u: 1,
      s: 1,
      a: 1,
    });
  });
  it('ALLOWED → Better Auth deletes; release runs in databaseHooks.user.delete.before (Task 12)', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    const r = await removeUser(admin, victim.authUserId);
    expect(r.status).toBe(200);
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 0, s: 0 });
  });
  it('/api-key/create refuses the reserved oak_ prefix in any case (INT-I9)', async () => {
    const user = await seed();
    for (const prefix of ['oak_x', 'OAK_', 'Oak_team']) {
      const r = await request(app.getHttpServer())
        .post('/api/auth/api-key/create')
        .set('authorization', `Bearer ${user.bearer}`)
        .send({ name: 'k', prefix });
      expect([r.status, r.body.code], prefix).toEqual([
        422,
        'validation_failed',
      ]);
      expect(r.body.errors?.[0]?.path).toBe('prefix');
    }
    const ok = await request(app.getHttpServer())
      .post('/api/auth/api-key/create')
      .set('authorization', `Bearer ${user.bearer}`)
      .send({ name: 'k', prefix: 'oakx' });
    expect(ok.status).toBe(200);
  });
});

describe('without a UserDeletionGuard the admin target id is still checked (review I1, R8-S2)', () => {
  let app: INestApplication;
  const seeded: SeededPrincipal[] = [];
  const seed = async (role?: string) => {
    const p = await seedUserPrincipal({ role });
    seeded.push(p);
    return p;
  };
  const removeUser = (as: SeededPrincipal, userId: unknown) =>
    request(app.getHttpServer())
      .post('/api/auth/admin/remove-user')
      .set('authorization', `Bearer ${as.bearer}`)
      .send({ userId });
  beforeAll(async () => {
    // App identity như SP2 (không tenancy, không FakeGuardModule): hook không có guard.
    app = await startIdentityApp();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
  });

  it("the admin's own id in uppercase → 422 validation_failed; the admin keeps its user and session", async () => {
    const admin = await seed('admin');
    const r = await removeUser(admin, admin.authUserId.toUpperCase());
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
    expect(r.body.errors?.[0]?.path).toBe('userId');
    expect(await credentialsLeft(admin.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it('a canonical lowercase id of another user is deleted as in SP2', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    const r = await removeUser(admin, victim.authUserId);
    expect(r.status).toBe(200);
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 0, s: 0 });
  });
});
