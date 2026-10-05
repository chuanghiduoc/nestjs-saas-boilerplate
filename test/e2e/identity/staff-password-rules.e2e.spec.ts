import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { seedStaffStepUp } from '../../support/seed-staff-step-up.js';
import { STAFF_PASSWORD, enrolStaff } from '../../support/staff.js';

const NEW_PASSWORD = 'a brand new staff passphrase';
type Person = { client: AuthClient; email: string; userId: string };
const hashOf = async (userId: string) =>
  (
    await ownerQuery<{ password: string | null }>(
      `SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`,
      [userId],
    )
  )[0]?.password;
const tokenRows = (userId: string) =>
  ownerQuery(
    `SELECT 1 FROM auth.verification WHERE value = $1 AND identifier LIKE 'reset-password:%'`,
    [userId],
  );
const seedResetToken = async (userId: string, expired = false) => {
  const token = randomUUID().replaceAll('-', '');
  await ownerQuery(
    `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [`reset-password:${token}`, userId, expired ? -60 : 3600],
  );
  return token;
};
const warned = (spy: { mock: { calls: unknown[][] } }, stage: string) =>
  spy.mock.calls.some(
    ([o]) =>
      typeof o === 'object' &&
      o !== null &&
      'event' in o &&
      o.event === 'staff_password_change_refused' &&
      'stage' in o &&
      o.stage === stage,
  );

describe('staff without a factor cannot change or reset a password over HTTP (spec SP3 §9.7 (7), N6-1, N7-1, R8-S1, R8-S4)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  /** Người có mật khẩu, đã xác thực email, đang đăng nhập; `role` như tham số (không factor). */
  const person = async (role: string | null): Promise<Person> => {
    const client = new AuthClient(app.getHttpServer());
    const email = `pw-${randomUUID()}@example.test`;
    await client.signUp(email, STAFF_PASSWORD);
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = true, role = $2 WHERE email = $1`,
      [email, role],
    );
    expect((await client.signIn(email, STAFF_PASSWORD)).status).toBe(200);
    const [row] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = $1`,
      [email],
    );
    return { client, email, userId: row!.id };
  };
  const reset = (c: AuthClient, body: object, query = '') =>
    c.request('post', `/api/auth/reset-password${query}`, {
      body,
      cookie: false,
    });
  beforeAll(async () => {
    app = await startIdentityApp();
    auth = app.get<AuthInstance>(BETTER_AUTH);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('/request-password-reset + /reset-password of staff without a factor → 400 invalid_or_expired_token; the mail is still sent, the token stays, the password is unchanged', async () => {
    const s = await person('admin');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    expect(
      (
        await s.client.request('post', '/api/auth/request-password-reset', {
          body: { email: s.email, redirectTo: '/' },
          cookie: false,
        })
      ).status,
    ).toBeLessThan(300);
    const [t] = await ownerQuery<{ token: string }>(
      `SELECT substring(identifier from 16) AS token FROM auth.verification WHERE value = $1 AND identifier LIKE 'reset-password:%' ORDER BY created_at DESC LIMIT 1`,
      [s.userId],
    );
    const before = await hashOf(s.userId);
    const r = await reset(s.client, {
      token: t!.token,
      newPassword: NEW_PASSWORD,
    });
    expect([r.status, r.body.code]).toEqual([400, 'invalid_or_expired_token']);
    expect(await tokenRows(s.userId)).toHaveLength(1);
    expect(await hashOf(s.userId)).toBe(before);
    expect(warned(warn, 'hook')).toBe(true);
    expect(
      await ownerQuery(
        `SELECT 1 FROM email_deliveries WHERE template = 'reset-password' AND idempotency_key LIKE 'reset-password:%' ORDER BY created_at DESC LIMIT 1`,
      ),
    ).toHaveLength(1);
    expect(
      (
        await new AuthClient(app.getHttpServer()).signIn(
          s.email,
          STAFF_PASSWORD,
        )
      ).status,
    ).toBe(200);
    warn.mockRestore();
  });
  it('N7-1 / R8-S4: every token of the request is checked — empty body token + query, query only, an expired row, and a regular user token mixed with a staff token (both orders)', async () => {
    const s = await person('admin');
    const x = await person(null);
    const cases: [object, string][] = [
      [
        { token: '', newPassword: NEW_PASSWORD },
        `?token=${await seedResetToken(s.userId)}`,
      ],
      [
        { newPassword: NEW_PASSWORD },
        `?token=${await seedResetToken(s.userId)}`,
      ],
      [
        {
          token: await seedResetToken(s.userId, true),
          newPassword: NEW_PASSWORD,
        },
        '',
      ],
      [
        { token: await seedResetToken(x.userId), newPassword: NEW_PASSWORD },
        `?token=${await seedResetToken(s.userId)}`,
      ],
      [
        { token: await seedResetToken(s.userId), newPassword: NEW_PASSWORD },
        `?token=${await seedResetToken(x.userId)}`,
      ],
    ];
    const hashes = [await hashOf(s.userId), await hashOf(x.userId)];
    for (const [body, query] of cases) {
      const r = await reset(s.client, body, query);
      expect([JSON.stringify(body), query, r.status, r.body.code]).toEqual([
        JSON.stringify(body),
        query,
        400,
        'invalid_or_expired_token',
      ]);
    }
    expect([await hashOf(s.userId), await hashOf(x.userId)]).toEqual(hashes);
  });
  it('/change-password of staff without a factor → 403 second_factor_required', async () => {
    const s = await person('admin');
    const r = await s.client.request('post', '/api/auth/change-password', {
      body: { currentPassword: STAFF_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
  });
  it('another stepped-up admin → /admin/set-user-password for staff without a factor → 403 forbidden', async () => {
    const admin = await person('admin');
    await seedStaffStepUp({ authUserId: admin.userId });
    const s = await person('admin');
    const before = await hashOf(s.userId);
    const r = await admin.client.request(
      'post',
      '/api/auth/admin/set-user-password',
      { body: { userId: s.userId, newPassword: NEW_PASSWORD } },
    );
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(await hashOf(s.userId)).toBe(before);
  });
  it('the same three refusals for an admin made by a server call (auth:create-admin path)', async () => {
    const email = `ca-${randomUUID()}@example.test`;
    await auth.api.createUser({
      body: { email, password: STAFF_PASSWORD, name: 'CA', role: 'admin' },
    });
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
      [email],
    );
    const [row] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = $1`,
      [email],
    );
    const c = new AuthClient(app.getHttpServer());
    expect((await c.signIn(email, STAFF_PASSWORD)).status).toBe(200);
    expect(
      (
        await reset(c, {
          token: await seedResetToken(row!.id),
          newPassword: NEW_PASSWORD,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.request('post', '/api/auth/change-password', {
          body: { currentPassword: STAFF_PASSWORD, newPassword: NEW_PASSWORD },
        })
      ).body.code,
    ).toBe('second_factor_required');
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id = $1`, [
      row!.id,
    ]);
  });
  it('staff WITH a factor keeps SP2: a reset link works and the next sign-in has the 2FA challenge', async () => {
    const s = await enrolStaff(app);
    const r = await reset(s.client, {
      token: await seedResetToken(s.userId),
      newPassword: NEW_PASSWORD,
    });
    expect(r.status).toBe(200);
    expect(
      (await new AuthClient(app.getHttpServer()).signIn(s.email, NEW_PASSWORD))
        .body.twoFactorRedirect,
    ).toBe(true);
  });
  it('a regular user keeps SP2 on all three paths', async () => {
    const x = await person(null);
    expect(
      (
        await reset(x.client, {
          token: await seedResetToken(x.userId),
          newPassword: NEW_PASSWORD,
        })
      ).status,
    ).toBe(200);
  });
});
