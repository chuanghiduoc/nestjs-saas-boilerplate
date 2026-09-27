import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import {
  ownerQuery,
  promoteToAdmin,
  startIdentityApp,
} from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const PASSWORD = 'correct horse battery';
const mail = mailpitFromInfra();
const userIdOf = async (email: string): Promise<string> => {
  const [row] = await ownerQuery<{ id: string }>(
    `SELECT id FROM auth."user" WHERE email = $1`,
    [email],
  );
  if (!row) throw new Error('user row not found');
  return row.id;
};

describe('web (cookie) and mobile (bearer) flows over real HTTP + Mailpit', () => {
  let app: INestApplication;
  const client = () => new AuthClient(app.getHttpServer());
  /** Đăng ký, mở link trong thư, đăng nhập: trả client đã có cookie + bearer. */
  const registered = async () => {
    const email = `w-${v7()}@example.test`;
    const c = client();
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    expect((await c.verifyEmailFromMailpit(mail, email)).status).toBeLessThan(
      400,
    );
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    return { email, c };
  };
  const adminClient = async () => {
    const { email, c } = await registered();
    await promoteToAdmin(email);
    await c.signIn(email, PASSWORD);
    return c;
  };
  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => app?.close());

  /** Trạng thái auth của user mà một lần reclaim (S2-R40/S2-R48) hay tạo session sẽ làm thay đổi. */
  const authState = async (email: string) => ({
    user: await ownerQuery(
      `SELECT email_verified, updated_at FROM auth."user" WHERE email = $1`,
      [email],
    ),
    sessions: await ownerQuery(
      `SELECT s.id, s.token, s.expires_at, s.updated_at FROM auth.session s
         JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1 ORDER BY s.id`,
      [email],
    ),
    accounts: await ownerQuery(
      `SELECT a.id, a.provider_id, a.password, a.updated_at FROM auth.account a
         JOIN auth."user" u ON u.id = a.user_id WHERE u.email = $1 ORDER BY a.id`,
      [email],
    ),
  });

  it('sign-up → verification email → the link has an effect once → sign-in sets an HttpOnly, host-only, Lax cookie', async () => {
    const email = `v-${v7()}@example.test`;
    const c = client();
    const started = Date.now();
    await c.signUp(email, PASSWORD);
    expect((await c.signIn(email, PASSWORD)).body.code).toBe(
      'email_not_verified',
    );
    const first = await c.verifyEmailFromMailpit(mail, email, started);
    expect(first.status).toBeLessThan(400);
    const res = await c.signIn(email, PASSWORD);
    expect(res.status).toBe(200);
    const cookie = [res.headers['set-cookie']]
      .flat()
      .find((x) => String(x).includes('session_token'));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect((await c.request('get', '/v1/me')).status).toBe(200);

    // Ruling S2-R52: "một lần" = link chỉ có tác dụng một lần (token là JWT không trạng thái của Better Auth).
    // Lần bấm thứ hai (vd. sau khi trình quét link đã mở trước) chỉ redirect: không cookie, không session mới,
    // không đổi `email_verified`, và không kích hoạt reclaim (session đang sống và account giữ nguyên).
    const before = await authState(email);
    expect(before.user).toEqual([
      expect.objectContaining({ email_verified: true }),
    ]);
    expect(before.sessions).toHaveLength(1);
    const second = await c.verifyEmailFromMailpit(mail, email, started);
    expect([second.status, second.headers.location]).toEqual([
      first.status,
      first.headers.location,
    ]);
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(second.headers['set-auth-token']).toBeUndefined();
    expect(await authState(email)).toEqual(before);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
  });
  it('mobile: the bearer from set-auth-token authenticates /v1/me without cookies', async () => {
    const { c } = await registered();
    expect(c.bearer).toBeTruthy();
    expect(
      (await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer }))
        .status,
    ).toBe(200);
  });
  it('logout deletes the session and expires the cookie; the old cookie is then rejected', async () => {
    const { c } = await registered();
    const oldCookie = c.cookieHeader();
    expect((await c.request('post', '/api/auth/sign-out')).status).toBe(200);
    expect(
      (await c.request('get', '/v1/me', { cookie: oldCookie })).status,
    ).toBe(401);
  });
  it('admin ban: cookie, bearer and API key of the victim are all 401 at the next request', async () => {
    const { email, c } = await registered();
    const key = (
      await c.request('post', '/api/auth/api-key/create', {
        body: { name: 'k' },
      })
    ).body.key;
    expect(
      (await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(200);
    const admin = await adminClient();
    const id = await userIdOf(email);
    expect(
      (
        await admin.request('post', '/api/auth/admin/ban-user', {
          body: { userId: id },
        })
      ).status,
    ).toBe(200);
    expect((await c.request('get', '/v1/me')).status).toBe(401);
    expect(
      (await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer }))
        .status,
    ).toBe(401);
    expect(
      (await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(401);
  });
  it('admin remove-user: API keys disappear with the user (FK cascade)', async () => {
    const { email, c } = await registered();
    await c.request('post', '/api/auth/api-key/create', {
      body: { name: 'k' },
    });
    const id = await userIdOf(email);
    expect(
      await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [
        id,
      ]),
    ).toHaveLength(1);
    const admin = await adminClient();
    expect(
      (
        await admin.request('post', '/api/auth/admin/remove-user', {
          body: { userId: id },
        })
      ).status,
    ).toBe(200);
    expect(
      await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [
        id,
      ]),
    ).toEqual([]);
  });
  it('forgot password → email → reset → old cookie and old bearer are 401', async () => {
    const { email, c } = await registered();
    const oldCookie = c.cookieHeader();
    const oldBearer = c.bearer;
    const started = Date.now();
    expect(
      (
        await client().request('post', '/api/auth/request-password-reset', {
          body: { email },
          cookie: false,
        })
      ).status,
    ).toBeLessThan(300);
    const msg = await mail.waitFor(email, {
      subject: /Reset your password/,
      after: started,
    });
    const token = /\/reset-password\/([^?\s"<>]+)/.exec(msg.Text)?.[1];
    expect(token).toBeTruthy();
    expect(
      (
        await client().request('post', '/api/auth/reset-password', {
          body: { token, newPassword: 'a whole new passphrase' },
          cookie: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (await c.request('get', '/v1/me', { cookie: oldCookie })).status,
    ).toBe(401);
    expect(
      (await c.request('get', '/v1/me', { cookie: false, bearer: oldBearer }))
        .status,
    ).toBe(401);
    expect((await client().signIn(email, PASSWORD)).body.code).toBe(
      'invalid_credentials',
    );
    expect(
      (await client().signIn(email, 'a whole new passphrase')).status,
    ).toBe(200);
  });
  it('change-password (client asks revokeOtherSessions=false): other cookie and bearer sessions are 401; the current one is replaced', async () => {
    const { email, c } = await registered();
    const other = client();
    await other.signIn(email, PASSWORD);
    expect(other.bearer).toBeTruthy();
    expect((await other.request('get', '/v1/me')).status).toBe(200);
    const key = (
      await c.request('post', '/api/auth/api-key/create', {
        body: { name: 'k' },
      })
    ).body.key;
    const oldCurrentCookie = c.cookieHeader();
    const r = await c.request('post', '/api/auth/change-password', {
      body: {
        currentPassword: PASSWORD,
        newPassword: 'changed passphrase ok',
        revokeOtherSessions: false,
      },
    });
    expect(r.status).toBe(200);
    expect((await other.request('get', '/v1/me')).status).toBe(401);
    expect(
      (
        await other.request('get', '/v1/me', {
          cookie: false,
          bearer: other.bearer,
        })
      ).status,
    ).toBe(401);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    expect(c.cookieHeader()).not.toBe(oldCurrentCookie);
    expect(
      (await c.request('get', '/v1/me', { cookie: oldCurrentCookie })).status,
    ).toBe(401);
    expect((await other.request('get', '/api/auth/token')).status).toBe(401);
    // Spec §1 tiêu chí 6: đổi mật khẩu không thu hồi API key (credential máy do user quản lý).
    expect(
      (await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(200);
  });
  it('re-registering with a differently cased email is indistinguishable and creates no row', async () => {
    const { email } = await registered();
    const a = await client().signUp(`other-${v7()}@example.test`, PASSWORD);
    const b = await client().signUp(`  ${email.toUpperCase()} `, PASSWORD);
    expect([b.status, b.text, b.headers['set-cookie']]).toEqual([
      a.status,
      a.text,
      a.headers['set-cookie'],
    ]);
    expect(
      await ownerQuery(
        `SELECT 1 FROM auth."user" WHERE lower(email) = lower($1)`,
        [email],
      ),
    ).toHaveLength(1);
  });
  it('a password longer than AUTH_PASSWORD_MAX_LENGTH is rejected with 422 before hashing', async () => {
    const r = await client().signUp(
      `long-${v7()}@example.test`,
      'x'.repeat(10_000),
    );
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
  });
});
