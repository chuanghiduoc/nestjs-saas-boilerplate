import { Global, Logger, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PlatformRoleChangeListener } from '../../../src/modules/identity/index.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { seedStaffFactor } from '../../support/seed-staff-step-up.js';
import { STAFF_PASSWORD, enrolStaff, stepUp } from '../../support/staff.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';

class FakeRoleChangeListener extends PlatformRoleChangeListener {
  readonly calls: string[] = [];
  fail = false;
  async onPlatformRoleChanged(authUserId: string): Promise<void> {
    this.calls.push(authUserId);
    if (this.fail) throw new Error('listener down');
  }
}
const listener = new FakeRoleChangeListener();
@Global()
@Module({
  providers: [{ provide: PlatformRoleChangeListener, useValue: listener }],
  exports: [PlatformRoleChangeListener],
})
class FakeListenerModule {}

const GATED_ADMIN: readonly [
  string,
  'get' | 'post',
  Record<string, unknown>,
][] = [
  ['/api/auth/admin/list-users', 'get', {}],
  ['/api/auth/admin/set-role', 'post', { role: 'user' }],
  [
    '/api/auth/admin/set-user-password',
    'post',
    { newPassword: 'n'.repeat(16) },
  ],
  [
    '/api/auth/admin/create-user',
    'post',
    {
      email: 'x@example.test',
      password: 'p'.repeat(16),
      name: 'X',
      role: 'admin',
    },
  ],
  ['/api/auth/admin/update-user', 'post', { data: { name: 'Renamed' } }],
];
const isEvent = (o: unknown, event: string): boolean =>
  typeof o === 'object' && o !== null && 'event' in o && o.event === event;

describe('staff platform-power gate (spec SP3 §9.7 (3)(4)(5)(6)(8), S-18, S-21, S-25, N5-1, N6-5, N7-2/3, R8-S2)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  const seeded: SeededPrincipal[] = [];
  const as = (p: SeededPrincipal) => ({
    get: (u: string) =>
      request(app.getHttpServer())
        .get(u)
        .set('authorization', `Bearer ${p.bearer}`)
        .set('origin', 'http://localhost:3000'),
    post: (u: string, body: object) =>
      request(app.getHttpServer())
        .post(u)
        .set('authorization', `Bearer ${p.bearer}`)
        .set('origin', 'http://localhost:3000')
        .send(body),
  });
  const roleOf = async (id: string) =>
    (
      await ownerQuery<{ role: string | null }>(
        `SELECT role FROM auth."user" WHERE id = $1`,
        [id],
      )
    )[0]?.role;
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [FakeListenerModule] });
    auth = app.get<AuthInstance>(BETTER_AUTH);
  });
  beforeEach(() => {
    listener.calls.length = 0;
    listener.fail = false;
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
    vi.unstubAllEnvs();
  });
  const staff = async (o?: Parameters<typeof seedStaffPrincipal>[0]) => {
    const p = await seedStaffPrincipal(o);
    seeded.push(p);
    return p;
  };

  it.each([
    ['no mark', { mark: false }],
    ['a backup_code mark', { method: 'backup_code' as const }],
    ['a TOTP mark older than AUTH_SESSION_FRESH_AGE_SEC', { markAgeSec: 3600 }],
  ])(
    'S-18: a staff session with %s is refused on every /admin/*, /token and factor read, with no DB change',
    async (_n, o) => {
      const p = await staff(o);
      const target = await seedUserPrincipal();
      seeded.push(target);
      for (const [path, method, body] of GATED_ADMIN) {
        const r =
          method === 'get'
            ? await as(p).get(path)
            : await as(p).post(path, { userId: target.authUserId, ...body });
        expect([path, r.status, r.body.code]).toEqual([
          path,
          403,
          'second_factor_required',
        ]);
      }
      for (const path of [
        '/api/auth/two-factor/get-totp-uri',
        '/api/auth/two-factor/generate-backup-codes',
      ])
        expect(
          (await as(p).post(path, { password: STAFF_PASSWORD })).body.code,
        ).toBe('second_factor_required');
      expect((await as(p).get('/api/auth/token')).body.code).toBe(
        'second_factor_required',
      );
      expect(await roleOf(target.authUserId)).toBeNull();
      expect(
        await ownerQuery(
          `SELECT 1 FROM auth."user" WHERE email = 'x@example.test'`,
        ),
      ).toEqual([]);
    },
  );
  it('S-18: after a real TOTP step-up the same calls pass; /token then carries role', async () => {
    const s = await enrolStaff(app);
    expect(
      (await s.client.request('get', '/api/auth/admin/list-users')).status,
    ).toBe(403);
    expect((await stepUp(s)).status).toBe(200);
    expect(
      (await s.client.request('get', '/api/auth/admin/list-users')).status,
    ).toBe(200);
    const t = await s.client.request('get', '/api/auth/token');
    expect(t.status).toBe(200);
    const payload: unknown = JSON.parse(
      Buffer.from(
        String(t.body.token).split('.')[1] ?? '',
        'base64url',
      ).toString('utf8'),
    );
    expect(payload).toMatchObject({ role: 'admin' });
    expect(
      (
        await s.client.request('post', '/api/auth/two-factor/get-totp-uri', {
          body: { password: STAFF_PASSWORD },
        })
      ).status,
    ).toBe(200);
  });
  it('S-18: a backup-code step-up opens none of /admin/*, get-totp-uri, generate-backup-codes', async () => {
    const s = await enrolStaff(app);
    expect((await stepUp(s, { backupCode: s.backupCodes[0] })).status).toBe(
      200,
    );
    expect(
      (await s.client.request('get', '/api/auth/admin/list-users')).body.code,
    ).toBe('second_factor_required');
    expect(
      (
        await s.client.request(
          'post',
          '/api/auth/two-factor/generate-backup-codes',
          {
            body: { password: STAFF_PASSWORD },
          },
        )
      ).body.code,
    ).toBe('second_factor_required');
  });
  it('(4): a staff member cannot /two-factor/disable, even with a fresh TOTP mark; a regular user still can (SP2)', async () => {
    const s = await enrolStaff(app);
    await stepUp(s);
    const r = await s.client.request('post', '/api/auth/two-factor/disable', {
      body: { password: STAFF_PASSWORD },
    });
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(
      await ownerQuery(`SELECT 1 FROM auth.two_factor WHERE user_id = $1`, [
        s.userId,
      ]),
    ).toHaveLength(1);
    const u = await enrolStaff(app, { role: 'user' });
    expect(
      (
        await u.client.request('post', '/api/auth/two-factor/disable', {
          body: { password: STAFF_PASSWORD },
        })
      ).status,
    ).toBe(200);
  });
  it('a regular user keeps SP2 behaviour on get-totp-uri, generate-backup-codes and /token', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    expect(
      (
        await u.client.request('post', '/api/auth/two-factor/get-totp-uri', {
          body: { password: STAFF_PASSWORD },
        })
      ).status,
    ).toBe(200);
    expect((await u.client.request('get', '/api/auth/token')).status).toBe(200);
  });
  it.each([
    { twoFactorEnabled: false },
    { two_factor_enabled: false },
    { TwoFactorEnabled: false },
  ])(
    'S-21: /admin/update-user with %j → 422, the flag does not change',
    async (data) => {
      const p = await staff();
      const target = await staff();
      const r = await as(p).post('/api/auth/admin/update-user', {
        userId: target.authUserId,
        data,
      });
      expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
      expect(
        (
          await ownerQuery(
            `SELECT two_factor_enabled FROM auth."user" WHERE id = $1`,
            [target.authUserId],
          )
        )[0],
      ).toEqual({ two_factor_enabled: true });
    },
  );
  it.each([
    ['/api/auth/admin/ban-user', {}],
    ['/api/auth/admin/list-user-sessions', {}],
    ['/api/auth/admin/update-user', { data: { banned: true } }],
  ])(
    'R8-S2: %s with an uppercase userId → 422 before any other rule; lowercase keeps SP2 behaviour',
    async (path, extra) => {
      const p = await staff();
      const r = await as(p).post(path, {
        userId: p.authUserId.toUpperCase(),
        ...extra,
      });
      expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
      expect(
        (
          await ownerQuery(`SELECT banned FROM auth."user" WHERE id = $1`, [
            p.authUserId,
          ])
        )[0],
      ).toEqual({
        banned: false,
      });
    },
  );
  it('/admin/impersonate-user stays disabled (SP2 D7): 404 whatever the id form, no session created for the target', async () => {
    const p = await staff();
    const target = await seedUserPrincipal({ role: 'admin' });
    seeded.push(target);
    const before = await ownerQuery(
      `SELECT id FROM auth.session WHERE user_id = $1`,
      [target.authUserId],
    );
    for (const userId of [target.authUserId, target.authUserId.toUpperCase()])
      expect(
        (await as(p).post('/api/auth/admin/impersonate-user', { userId }))
          .status,
      ).toBe(404);
    expect(
      await ownerQuery(`SELECT id FROM auth.session WHERE user_id = $1`, [
        target.authUserId,
      ]),
    ).toEqual(before);
  });
  describe('S-25 (T-41): the last platform admin cannot drop their own admin role', () => {
    let me: SeededPrincipal;
    beforeEach(async () => {
      me = await staff();
      // Integration chạy tuần tự theo file: admin do file khác để lại được hạ, để "admin cuối cùng" có nghĩa trong file này.
      await ownerQuery(
        `UPDATE auth."user" SET role = 'user' WHERE id <> $1 AND role IS NOT NULL AND role <> 'user'`,
        [me.authUserId],
      );
    });
    it.each([
      ['/api/auth/admin/set-role', { role: 'user' }],
      ['/api/auth/admin/set-role', { role: ['user'] }],
      ['/api/auth/admin/set-role', { role: 'user, admin' }],
      ['/api/auth/admin/set-role', { role: ' admin' }],
      ['/api/auth/admin/update-user', { data: { role: 'user' } }],
    ])(
      '%s %j on myself → 409 last_platform_admin, role unchanged, grant port not called',
      async (path, body) => {
        const info = vi.spyOn(Logger.prototype, 'log');
        const r = await as(me).post(path, { userId: me.authUserId, ...body });
        expect([r.status, r.body.code]).toEqual([409, 'last_platform_admin']);
        expect(await roleOf(me.authUserId)).toBe('admin');
        expect(listener.calls).toEqual([]);
        expect(
          info.mock.calls.some(([o]) =>
            isEvent(o, 'last_platform_admin_refused'),
          ),
        ).toBe(true);
        info.mockRestore();
      },
    );
    it('userId as a one-element array is read like the plugin (z.coerce.string) → 409', async () => {
      expect(
        (
          await as(me).post('/api/auth/admin/set-role', {
            userId: [me.authUserId],
            role: 'user',
          })
        ).status,
      ).toBe(409);
    });
    it("role 'admin,user' keeps admin → 200; a user with role 'user, admin' does not count as another admin → 409", async () => {
      expect(
        (
          await as(me).post('/api/auth/admin/set-role', {
            userId: me.authUserId,
            role: 'admin,user',
          })
        ).status,
      ).toBe(200);
      const ws = await seedUserPrincipal({ role: 'user, admin' });
      seeded.push(ws);
      expect(
        (
          await as(me).post('/api/auth/admin/set-role', {
            userId: me.authUserId,
            role: 'user',
          })
        ).status,
      ).toBe(409);
    });
    it('another non-banned admin → 200 (SP2); the only other admin banned → 409', async () => {
      const other = await staff();
      await ownerQuery(`UPDATE auth."user" SET banned = true WHERE id = $1`, [
        other.authUserId,
      ]);
      expect(
        (
          await as(me).post('/api/auth/admin/set-role', {
            userId: me.authUserId,
            role: 'user',
          })
        ).status,
      ).toBe(409);
      await ownerQuery(`UPDATE auth."user" SET banned = false WHERE id = $1`, [
        other.authUserId,
      ]);
      expect(
        (
          await as(me).post('/api/auth/admin/set-role', {
            userId: me.authUserId,
            role: 'user',
          })
        ).status,
      ).toBe(200);
      expect(listener.calls).toEqual([me.authUserId]);
    });
    it('a stale session is refused by the TOTP gate before this rule', async () => {
      const stale = await staff({ mark: false });
      expect(
        (
          await as(stale).post('/api/auth/admin/set-role', {
            userId: stale.authUserId,
            role: 'user',
          })
        ).body.code,
      ).toBe('second_factor_required');
    });
  });
  describe('(6) writing a platform role calls PlatformRoleChangeListener with the plugin-coerced lowercase id (S-23 identity part)', () => {
    it('set-role, update-user with data.role → called once each; update-user without role → not called', async () => {
      const p = await staff();
      const t = await staff();
      await as(p).post('/api/auth/admin/set-role', {
        userId: [t.authUserId],
        role: 'user',
      });
      await as(p).post('/api/auth/admin/update-user', {
        userId: t.authUserId,
        data: { role: 'admin' },
      });
      await as(p).post('/api/auth/admin/update-user', {
        userId: t.authUserId,
        data: { name: 'N' },
      });
      expect(listener.calls).toEqual([t.authUserId, t.authUserId]);
    });
    it('the port throws → 503 service_unavailable + ERROR log; the role is written; the same request again calls the port again', async () => {
      const p = await staff();
      const t = await staff();
      listener.fail = true;
      const errors = vi.spyOn(Logger.prototype, 'error');
      const r = await as(p).post('/api/auth/admin/set-role', {
        userId: t.authUserId,
        role: 'user',
      });
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(await roleOf(t.authUserId)).toBe('user');
      expect(
        errors.mock.calls.some(([o]) =>
          isEvent(o, 'platform_role_change_listener_failed'),
        ),
      ).toBe(true);
      errors.mockRestore();
      listener.fail = false;
      expect(
        (
          await as(p).post('/api/auth/admin/set-role', {
            userId: t.authUserId,
            role: 'user',
          })
        ).status,
      ).toBe(200);
      expect(listener.calls).toEqual([t.authUserId, t.authUserId]);
    });
    it('an uppercase target id → 422, role unchanged, port not called', async () => {
      const p = await staff();
      const t = await staff();
      expect(
        (
          await as(p).post('/api/auth/admin/set-role', {
            userId: t.authUserId.toUpperCase(),
            role: 'user',
          })
        ).status,
      ).toBe(422);
      expect(await roleOf(t.authUserId)).toBe('admin');
      expect(listener.calls).toEqual([]);
    });
  });
  it('S-18: the first admin made by a server call (auth:create-admin path, no session) is still created', async () => {
    const email = `first-admin-${Date.now()}@example.test`;
    const r = await auth.api.createUser({
      body: { email, password: 'p'.repeat(16), name: 'First', role: 'admin' },
    });
    expect(r.user.email).toBe(email);
    const [row] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = $1`,
      [email],
    );
    await seedStaffFactor(row!.id); // dọn: không để admin chưa có factor rơi vào ca "admin cuối" của file khác
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id = $1`, [
      row!.id,
    ]);
  });
});
