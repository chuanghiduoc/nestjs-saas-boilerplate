import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { Response } from 'supertest';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createEmailVerificationToken } from 'better-auth/api';
import {
  AuthProviderRegistrationError,
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AuthClient, TEST_ORIGIN } from '../../support/auth-client.js';
import { TEST_BETTER_AUTH_SECRET } from '../../support/env.js';
import {
  FAKE_IDP_CLIENT_ID,
  FAKE_IDP_CLIENT_SECRET,
  startFakeIdp,
  type FakeIdp,
  type IdTokenMode,
} from '../../support/fake-idp.js';
import {
  buildIdentityApp,
  ownerQuery,
  promoteToStaff,
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';
import { getInfra } from '../../support/infra.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { installOtelCapture } from '../../support/otel-capture.js';

/** Task 40 M8: `identity_account_reclaimed_total{trigger}` được đọc lại trong test S2-R48. */
const otel = installOtelCapture();
const PROVIDER = 'corp';
const PASSWORD = 'correct horse battery';
const CALLBACK_URL = '/';
const HTTP_FOUND = 302;
/** Mã lỗi trong redirect lỗi của `/callback/:id` (`oauth2/errors.mjs`, `auth-error.mapper.ts`). */
const NOT_LINKED = 'account_not_linked';
const LINK_REFUSED = 'unable_to_link_account';
const NO_USER_INFO = 'unable_to_get_user_info';
const SESSION_REVOKED = 'OAUTH_SESSION_REVOKED';
/** N1: pool `auth_user` nhỏ hơn số lần đăng ký song song. */
const SMALL_AUTH_POOL = 2;
const CONCURRENT_SIGN_UPS = 6;
const LOCK_POLL_MS = 50;
const LOCK_WAIT_TIMEOUT_MS = 15_000;
/** `iat` của JWT tính bằng giây (S2-R76: token đổi email so với giây của reclaim). */
const JWT_IAT_RESOLUTION_MS = 1000;
/** `AUTH_EMAIL_TOKEN_TTL_SEC` mặc định: thời hạn của token mà nhánh một bước cũ gửi cho kẻ tấn công (C2). */
const EMAIL_TOKEN_TTL_SEC = 86_400;
const mail = mailpitFromInfra();

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({
    redirectUri: `${TEST_ORIGIN}/api/auth/callback/${PROVIDER}`,
  });
});
afterAll(async () => idp?.close());

const oidcEnv = (trusted: string, extra: Record<string, string> = {}) => ({
  AUTH_MODE: 'hybrid',
  AUTH_OIDC_PROVIDER_ID: PROVIDER,
  AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
  AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
  AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
  AUTH_TRUSTED_PROVIDERS: trusted,
  ...extra,
});

const setCookies = (res: Response): string[] => {
  const raw: unknown = res.headers['set-cookie'];
  return Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === 'string')
    : [];
};
/** Callback có cấp cookie session (giá trị khác rỗng, không phải lệnh xoá) hay không. */
const setsSessionCookie = (res: Response): boolean =>
  setCookies(res).some(
    (c) => /session_token=[^;]+/.test(c) && !/max-age=0/i.test(c),
  );
const location = (res: Response): URL => {
  expect(res.status).toBe(HTTP_FOUND);
  const loc: unknown = res.headers.location;
  if (typeof loc !== 'string') throw new Error('callback did not redirect');
  return new URL(loc, 'http://localhost:3000');
};
const errorOf = (res: Response): string | null =>
  location(res).searchParams.get('error');

const userIdOf = async (email: string): Promise<string> => {
  const [row] = await ownerQuery<{ id: string }>(
    `SELECT id FROM auth."user" WHERE email = $1`,
    [email],
  );
  if (!row) throw new Error('user row not found');
  return row.id;
};
const providerAccounts = (email: string) =>
  ownerQuery<{ access_token: string | null; id_token: string | null }>(
    `SELECT a.access_token, a.id_token FROM auth.account a JOIN auth."user" u ON u.id = a.user_id
      WHERE u.email = $1 AND a.provider_id = $2`,
    [email, PROVIDER],
  );
const accountProviders = async (email: string): Promise<string[]> =>
  (
    await ownerQuery<{ provider_id: string }>(
      `SELECT a.provider_id FROM auth.account a JOIN auth."user" u ON u.id = a.user_id
        WHERE u.email = $1 ORDER BY a.provider_id`,
      [email],
    )
  ).map((r) => r.provider_id);
const sessionCount = async (email: string): Promise<number> =>
  (
    await ownerQuery(
      `SELECT 1 FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
      [email],
    )
  ).length;
const isVerified = async (email: string): Promise<boolean> => {
  const [row] = await ownerQuery<{ email_verified: boolean }>(
    `SELECT email_verified FROM auth."user" WHERE email = $1`,
    [email],
  );
  if (!row) throw new Error('user row not found');
  return row.email_verified;
};

/**
 * Bắt đầu một lần đăng nhập qua IdP như trình duyệt: `/sign-in/social` (genericOAuth 1.7.6 không có endpoint riêng,
 * provider đi qua `signIn.social` + `/callback/:id`) → IdP `/authorize` (claim chụp lại lúc này) → URL callback.
 */
async function beginLogin(
  c: AuthClient,
  claims: Record<string, unknown>,
  startPath = '/api/auth/sign-in/social',
): Promise<string> {
  const start = await c.request('post', startPath, {
    body: { provider: PROVIDER, callbackURL: CALLBACK_URL },
    // Luồng đăng nhập mới không mang cookie cũ; luồng `/link-social` cần cookie session của chủ tài khoản.
    ...(startPath.endsWith('/link-social') ? {} : { cookie: false }),
  });
  expect(start.status).toBe(200);
  idp.setClaims(claims);
  const back = await idp.authorize(String(start.body.url));
  return `${back.pathname}${back.search}`;
}
async function idpLogin(
  app: INestApplication,
  claims: Record<string, unknown>,
): Promise<{ c: AuthClient; res: Response }> {
  const c = new AuthClient(app.getHttpServer());
  const res = await c.request('get', await beginLogin(c, claims));
  return { c, res };
}
const claimsFor = (email: string, extra: Record<string, unknown> = {}) => ({
  sub: `idp-${v7()}`,
  email,
  name: 'IdP User',
  ...extra,
});

async function adminClient(app: INestApplication): Promise<AuthClient> {
  const email = `adm-${v7()}@example.test`;
  const c = new AuthClient(app.getHttpServer());
  await c.signUp(email, PASSWORD);
  await verifyEmailDirect(email);
  expect((await c.signIn(email, PASSWORD)).status).toBe(200);
  // Spec SP3 §5.3 (3D, N5-1): `/admin/create-user` của nhân viên đòi dấu TOTP; dấu gắn với session nên đặt SAU khi đăng nhập.
  await promoteToStaff(email);
  return c;
}
/**
 * User local KHÔNG có mật khẩu (admin tạo, đường có sẵn cho user chỉ đăng nhập qua IdP): ma trận §5.4 kiểm đúng
 * chính sách `accountLinking` + mapper, không bị luật S2-R49 (user có mật khẩu) che mất.
 */
async function passwordlessUser(
  admin: AuthClient,
  verified: boolean,
): Promise<string> {
  const email = `o-${v7()}@example.test`;
  const r = await admin.request('post', '/api/auth/admin/create-user', {
    body: { email, name: 'Local User' },
  });
  expect(r.status).toBe(200);
  if (verified) await verifyEmailDirect(email);
  expect(await accountProviders(email)).toEqual([]);
  return email;
}

/** Connection owner riêng để giữ khoá qua nhiều bước (ownerQuery mở/đóng một client mỗi câu). */
async function ownerClient(): Promise<pg.Client> {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await c.connect();
  return c;
}
/** Câu lệnh đang chờ khoá bảng `auth.session`. */
const SESSION_TABLE_WAITERS = `SELECT count(*)::int AS waiting FROM pg_locks
  WHERE relation = 'auth.session'::regclass AND NOT granted`;
/**
 * Câu lệnh đang chờ khoá dòng của transaction `$1` (khoá `transactionid` của nó) hoặc xếp hàng sau bên chờ đầu tiên
 * trên dòng `auth."user"` (khoá `tuple`).
 */
const USER_ROW_WAITERS = `SELECT count(*)::int AS waiting FROM pg_locks
  WHERE NOT granted AND (
    (locktype = 'transactionid' AND transactionid::text = $1)
    OR (locktype = 'tuple' AND relation = 'auth."user"'::regclass))`;
/** Barrier theo khoá (không theo thời gian): chờ tới khi đủ `n` câu lệnh đang đợi; có trần để lỗi to thay vì treo. */
async function waitForBlocked(
  sql: string,
  params: unknown[],
  n: number,
): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    const [row] = await ownerQuery<{ waiting: number }>(sql, params);
    if ((row?.waiting ?? 0) >= n) return;
    if (Date.now() > deadline)
      throw new Error(`expected ${n} statements waiting on a lock`);
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

/** Sang giây kế tiếp: mọi token phát trước đó có `iat` nhỏ hơn giây của reclaim sau đó. */
const nextSecond = () =>
  new Promise((r) =>
    setTimeout(
      r,
      JWT_IAT_RESOLUTION_MS - (Date.now() % JWT_IAT_RESOLUTION_MS) + 10,
    ),
  );
const apiKeyCount = async (email: string): Promise<number> =>
  (
    await ownerQuery(
      `SELECT 1 FROM auth.apikey k JOIN auth."user" u ON u.id = k.reference_id WHERE u.email = $1`,
      [email],
    )
  ).length;
/** Nạn nhân đặt lại mật khẩu qua thư thật (reclaim nhánh reset, S2-R40). */
async function victimResets(
  app: INestApplication,
  victim: string,
  newPassword: string,
): Promise<void> {
  const helper = new AuthClient(app.getHttpServer());
  const started = await mail.now();
  expect(
    (
      await helper.request('post', '/api/auth/request-password-reset', {
        body: { email: victim },
        cookie: false,
      })
    ).status,
  ).toBeLessThan(300);
  const msg = await mail.waitFor(victim, {
    subject: /Reset your password/,
    after: started,
  });
  const token = /\/reset-password\/([^?\s"<>]+)/.exec(msg.Text)?.[1];
  expect(token).toBeTruthy();
  expect(
    (
      await helper.request('post', '/api/auth/reset-password', {
        body: { token, newPassword },
        cookie: false,
      })
    ).status,
  ).toBe(200);
}

/** Kẻ tấn công đăng nhập qua IdP bằng email của nạn nhân khi nạn nhân chưa có tài khoản (tiền chiếm, S2-R40). */
async function preHijack(
  app: INestApplication,
  victimEmail: string,
  emailVerifiedClaim: unknown,
) {
  const claims = claimsFor(victimEmail, {
    email_verified: emailVerifiedClaim,
  });
  const started = await mail.now();
  const { c, res } = await idpLogin(app, claims);
  expect(errorOf(res)).toBeNull();
  expect(setsSessionCookie(res)).toBe(true);
  expect(await isVerified(victimEmail)).toBe(false);
  expect(await accountProviders(victimEmail)).toEqual([PROVIDER]);
  expect(
    (await c.request('get', '/api/auth/get-session')).body?.user?.email,
  ).toBe(victimEmail);
  return { attacker: c, claims, started };
}

describe('OIDC via a real authorization-code callback (hybrid, untrusted provider)', () => {
  let app: INestApplication;
  let admin: AuthClient;
  beforeAll(async () => {
    app = await startIdentityApp({ env: oidcEnv('') });
    admin = await adminClient(app);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('§5.4 untrusted provider + email_verified=true + verified local user → not linked, no session', async () => {
    const email = await passwordlessUser(admin, true);
    const { res } = await idpLogin(
      app,
      claimsFor(email, { email_verified: true }),
    );
    expect(errorOf(res)).toBe(NOT_LINKED);
    expect(setsSessionCookie(res)).toBe(false);
    expect(await providerAccounts(email)).toEqual([]);
    expect(await sessionCount(email)).toBe(0);
  });

  it('DB final review M4: an IdP email with surrounding spaces and upper case signs up under the normalized address (no 23514 from the canonical-email CHECK)', async () => {
    const id = v7();
    const normalized = `idp-${id}@example.test`;
    const { res } = await idpLogin(
      app,
      claimsFor(`  IdP-${id}@Example.TEST `, { email_verified: true }),
    );
    expect(errorOf(res)).toBeNull();
    expect(setsSessionCookie(res)).toBe(true);
    expect(await accountProviders(normalized)).toEqual([PROVIDER]);
  });

  it('AUTH final review concern 3: an IdP email with surrounding spaces and upper case finds the EXISTING user (no UNIQUE failure): untrusted provider → not linked, no session, no second user', async () => {
    const email = await passwordlessUser(admin, true);
    const { res } = await idpLogin(
      app,
      claimsFor(`  ${email.toUpperCase()} `, { email_verified: true }),
    );
    expect(errorOf(res)).toBe(NOT_LINKED);
    expect(setsSessionCookie(res)).toBe(false);
    expect(await providerAccounts(email)).toEqual([]);
    expect(await sessionCount(email)).toBe(0);
  });

  it('S2-R40 (a) reset branch: after the victim resets the password, the attacker IdP login no longer reaches the account', async () => {
    const victim = `v-${v7()}@example.test`;
    const { attacker, claims } = await preHijack(app, victim, true);
    const started = await mail.now();
    const helper = new AuthClient(app.getHttpServer());
    expect(
      (
        await helper.request('post', '/api/auth/request-password-reset', {
          body: { email: victim },
          cookie: false,
        })
      ).status,
    ).toBeLessThan(300);
    const msg = await mail.waitFor(victim, {
      subject: /Reset your password/,
      after: started,
    });
    const token = /\/reset-password\/([^?\s"<>]+)/.exec(msg.Text)?.[1];
    expect(token).toBeTruthy();
    expect(
      (
        await helper.request('post', '/api/auth/reset-password', {
          body: { token, newPassword: 'victim owns this now' },
          cookie: false,
        })
      ).status,
    ).toBe(200);
    expect(await accountProviders(victim)).toEqual(['credential']);
    expect(await sessionCount(victim)).toBe(0);
    expect((await attacker.request('get', '/api/auth/get-session')).body).toBe(
      null,
    );

    const { res } = await idpLogin(app, claims);
    expect(errorOf(res)).toBe(NOT_LINKED);
    expect(setsSessionCookie(res)).toBe(false);
    expect(await accountProviders(victim)).toEqual(['credential']);
    expect(await sessionCount(victim)).toBe(0);
  });

  it('S2-R40 (b) verification-link branch: after the victim clicks the verification link, the attacker IdP login no longer reaches the account', async () => {
    const victim = `v-${v7()}@example.test`;
    const { attacker, claims, started } = await preHijack(app, victim, true);
    const helper = new AuthClient(app.getHttpServer());
    const reclaimedBefore =
      (await otel.metric('identity_account_reclaimed_total', {
        trigger: 'email-verification',
      })) ?? 0;
    expect(
      (await helper.verifyEmailFromMailpit(mail, victim, started)).status,
    ).toBeLessThan(400);
    expect(await isVerified(victim)).toBe(true);
    expect(
      await otel.metric('identity_account_reclaimed_total', {
        trigger: 'email-verification',
      }),
    ).toBe(reclaimedBefore + 1);
    expect(await accountProviders(victim)).toEqual([]);
    expect(await sessionCount(victim)).toBe(0);
    expect((await attacker.request('get', '/api/auth/get-session')).body).toBe(
      null,
    );

    const { res } = await idpLogin(app, claims);
    expect(errorOf(res)).toBe(NOT_LINKED);
    expect(setsSessionCookie(res)).toBe(false);
    expect(await accountProviders(victim)).toEqual([]);
    expect(await sessionCount(victim)).toBe(0);
  });

  it('S2-R76 / C1: the unverified IdP session is not a principal and cannot mint an API key; a key that already exists is revoked by the reclaim and never authenticates', async () => {
    const victim = `v-${v7()}@example.test`;
    const { attacker, started } = await preHijack(app, victim, true);
    // Final review C1 step 2: the fresh, unverified session mints an API key.
    const minted = await attacker.request('post', '/api/auth/api-key/create', {
      body: { name: 'persistence' },
    });
    expect([minted.status, minted.body.code]).toEqual([
      403,
      'email_not_verified',
    ]);
    expect(await apiKeyCount(victim)).toBe(0);
    // AUTH_REQUIRE_EMAIL_VERIFICATION=true (default): not a usable principal on Nest routes either.
    const me = await attacker.request('get', '/v1/me');
    expect([me.status, me.body.code]).toEqual([403, 'email_not_verified']);

    // A key that exists before the reclaim anyway (minted before S2-R76 shipped; server-side creation still can).
    const auth = app.get<AuthInstance>(BETTER_AUTH);
    const legacy = await auth.api.createApiKey({
      body: { userId: await userIdOf(victim) },
    });
    const withKey = () =>
      new AuthClient(app.getHttpServer()).request('get', '/v1/me', {
        cookie: false,
        apiKey: legacy.key,
      });
    expect((await withKey()).status).toBe(401);

    // Final review C1 step 3: the victim resets the password, then verifies the address.
    await victimResets(app, victim, 'victim owns this now');
    expect(await apiKeyCount(victim)).toBe(0);
    expect(await sessionCount(victim)).toBe(0);
    expect(
      (
        await new AuthClient(app.getHttpServer()).verifyEmailFromMailpit(
          mail,
          victim,
          started,
        )
      ).status,
    ).toBeLessThan(400);
    expect(await isVerified(victim)).toBe(true);
    // Step 4: the key does not authenticate as the (now verified) victim.
    expect((await withKey()).status).toBe(401);
    expect((await attacker.request('get', '/v1/me')).status).toBe(401);
  });

  it('S2-R76 / C2 (a): the unverified IdP session cannot start a change of email (the one-step branch that mailed the attacker a takeover token is closed)', async () => {
    const victim = `v-${v7()}@example.test`;
    const { attacker } = await preHijack(app, victim, true);
    const attackerMailbox = `evil-${v7()}@example.test`;
    const r = await attacker.request('post', '/api/auth/change-email', {
      body: { newEmail: attackerMailbox },
    });
    // Refused in `hooks.before`, before Better Auth mints or mails anything (the integration spec also checks that no
    // delivery row is written).
    expect([r.status, r.body.code]).toEqual([403, 'email_not_verified']);
  });

  it('S2-R76 / C2 (b): a change-email token issued before the reclaim cannot take over the reclaimed account (no session, no email change); the owner can still change the email afterwards', async () => {
    const victim = `v-${v7()}@example.test`;
    const { started } = await preHijack(app, victim, true);
    const attackerMailbox = `evil-${v7()}@example.test`;
    // Final review C2 step 1: token T that the pre-S2-R76 one-step branch mailed to the attacker
    // (`update-user.mjs`: { email: <victim>, updateTo, requestType: 'change-email-verification' }, 24 h).
    const takeover = await createEmailVerificationToken(
      TEST_BETTER_AUTH_SECRET,
      victim,
      attackerMailbox,
      EMAIL_TOKEN_TTL_SEC,
      { requestType: 'change-email-verification' },
    );
    await nextSecond();
    // Step 2: the victim reclaims (reset, then verify).
    const password = 'victim owns this now';
    await victimResets(app, victim, password);
    expect(
      (
        await new AuthClient(app.getHttpServer()).verifyEmailFromMailpit(
          mail,
          victim,
          started,
        )
      ).status,
    ).toBeLessThan(400);
    expect(await isVerified(victim)).toBe(true);

    // Step 3: the attacker opens T with no session.
    const opener = new AuthClient(app.getHttpServer());
    const res = await opener.request(
      'get',
      `/api/auth/verify-email?token=${takeover}&callbackURL=${encodeURIComponent(CALLBACK_URL)}`,
      { cookie: false },
    );
    expect([res.status, res.body.code]).toEqual([
      400,
      'invalid_or_expired_token',
    ]);
    expect(setsSessionCookie(res)).toBe(false);
    expect(await sessionCount(victim)).toBe(0);
    expect(
      await ownerQuery(`SELECT 1 FROM auth."user" WHERE email = $1`, [
        attackerMailbox,
      ]),
    ).toEqual([]);
    expect(await isVerified(victim)).toBe(true);
    expect((await opener.request('get', '/v1/me')).status).toBe(401);

    // The owner's own change of email after the reclaim still works end to end.
    const owner = new AuthClient(app.getHttpServer());
    expect((await owner.signIn(victim, password)).status).toBe(200);
    const newEmail = `moved-${v7()}@example.test`;
    const asked = await mail.now();
    expect(
      (
        await owner.request('post', '/api/auth/change-email', {
          body: { newEmail },
        })
      ).status,
    ).toBe(202);
    const confirm = await mail.waitFor(victim, {
      subject: /Confirm your account email change/,
      after: asked,
    });
    const linkOf = (text: string): string => {
      const link =
        /https?:\/\/[^\s"<>]+\/api\/auth\/verify-email\?[^\s"<>]+/.exec(
          text,
        )?.[0];
      if (!link) throw new Error('no verify-email link in the email');
      const u = new URL(link.replaceAll('&amp;', '&'));
      return `${u.pathname}${u.search}`;
    };
    const clicked = await mail.now();
    expect(
      (
        await new AuthClient(app.getHttpServer()).request(
          'get',
          linkOf(confirm.Text),
          { cookie: false },
        )
      ).status,
    ).toBeLessThan(400);
    const verify = await mail.waitFor(newEmail, {
      subject: /Verify your email/,
      after: clicked,
    });
    expect(
      (
        await new AuthClient(app.getHttpServer()).request(
          'get',
          linkOf(verify.Text),
          { cookie: false },
        )
      ).status,
    ).toBeLessThan(400);
    expect(await isVerified(newEmail)).toBe(true);
  });

  it('S2-R40 (c) I1 race: an IdP login in flight across the reclaim leaves no live session, sets no cookie and redirects with OAUTH_SESSION_REVOKED', async () => {
    const victim = `v-${v7()}@example.test`;
    const { claims, started } = await preHijack(app, victim, true);
    // Lần đăng nhập thứ hai của kẻ tấn công: đã qua IdP, đọc được dòng `account` (callback chưa chạy).
    const attacker = new AuthClient(app.getHttpServer());
    const callback = await beginLogin(attacker, claims);
    const victimClient = new AuthClient(app.getHttpServer());
    await mail.waitFor(victim, {
      subject: /Verify your email/,
      after: started,
    });

    // Xếp thứ tự thật trên Postgres: giữ SHARE lock trên `auth.session` (chặn mọi INSERT/DELETE session) để
    // (1) lần đăng nhập đọc account, gia hạn token rồi đứng ở INSERT session; (2) reclaim khoá dòng user, xoá account
    // rồi đứng ở DELETE session. Nhả lock: INSERT phải chờ khoá FK (`FOR KEY SHARE`) tới khi reclaim COMMIT, nên
    // session của lần đăng nhập commit SAU reclaim — đúng race I1 mà hàng rào `session.create.after` phải chặn.
    const lock = await ownerClient();
    let login: Promise<Response> | undefined;
    let verify: Promise<Response> | undefined;
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE auth.session IN SHARE MODE');
      login = attacker.request('get', callback);
      await waitForBlocked(SESSION_TABLE_WAITERS, [], 1);
      verify = victimClient.verifyEmailFromMailpit(mail, victim, started);
      await waitForBlocked(SESSION_TABLE_WAITERS, [], 2);
      await lock.query('COMMIT');
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      try {
        await lock.end();
      } finally {
        await Promise.allSettled([login, verify]);
      }
    }
    const [loginRes, verifyRes] = await Promise.all([login, verify]);
    expect(verifyRes.status).toBeLessThan(400);
    expect(errorOf(loginRes)).toBe(SESSION_REVOKED);
    expect(setsSessionCookie(loginRes)).toBe(false);
    expect(await sessionCount(victim)).toBe(0);
    expect(await accountProviders(victim)).toEqual([]);
    expect(await isVerified(victim)).toBe(true);
    expect((await attacker.request('get', '/api/auth/get-session')).body).toBe(
      null,
    );
  });

  it('S2-R40 (c) I1 race, other interleaving: the session commits before the reclaim locks the user but the fence runs after the reclaim; still no cookie and OAUTH_SESSION_REVOKED', async () => {
    const victim = `v-${v7()}@example.test`;
    const { claims, started } = await preHijack(app, victim, true);
    const userId = await userIdOf(victim);
    const attacker = new AuthClient(app.getHttpServer());
    const callback = await beginLogin(attacker, claims);
    const victimClient = new AuthClient(app.getHttpServer());
    await mail.waitFor(victim, {
      subject: /Verify your email/,
      after: started,
    });

    // `FOR NO KEY UPDATE` trên dòng user: chặn `FOR UPDATE` của reclaim và `FOR SHARE` của hàng rào, nhưng KHÔNG chặn
    // `FOR KEY SHARE` của khoá FK khi INSERT session. Thứ tự: (1) reclaim xếp hàng đầu tiên trên dòng user;
    // (2) lần đăng nhập INSERT + commit session (TRƯỚC khi reclaim có khoá), rồi hàng rào xếp hàng SAU reclaim.
    // Nhả khoá: reclaim chạy trước, xoá cả session đó; hàng rào chạy sau reclaim và thấy session đã mất.
    const lock = await ownerClient();
    let login: Promise<Response> | undefined;
    let verify: Promise<Response> | undefined;
    try {
      await lock.query('BEGIN');
      await lock.query(
        `SELECT 1 FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`,
        [userId],
      );
      const [{ xid } = { xid: '' }] = (
        await lock.query<{ xid: string }>(
          `SELECT pg_current_xact_id()::text AS xid`,
        )
      ).rows;
      verify = victimClient.verifyEmailFromMailpit(mail, victim, started);
      await waitForBlocked(USER_ROW_WAITERS, [xid], 1);
      login = attacker.request('get', callback);
      await waitForBlocked(USER_ROW_WAITERS, [xid], 2);
      await lock.query('COMMIT');
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      try {
        await lock.end();
      } finally {
        await Promise.allSettled([login, verify]);
      }
    }
    const [loginRes, verifyRes] = await Promise.all([login, verify]);
    expect(verifyRes.status).toBeLessThan(400);
    expect(errorOf(loginRes)).toBe(SESSION_REVOKED);
    expect(setsSessionCookie(loginRes)).toBe(false);
    expect(await sessionCount(victim)).toBe(0);
    expect(await accountProviders(victim)).toEqual([]);
  });
});

describe('OIDC via a real authorization-code callback (hybrid, trusted provider)', () => {
  let app: INestApplication;
  let admin: AuthClient;
  beforeAll(async () => {
    app = await startIdentityApp({ env: oidcEnv(PROVIDER) });
    admin = await adminClient(app);
  });
  afterEach(() => idp.setIdTokenMode('signed'));
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it.each([
    ['claim missing', true, {}],
    ['email_verified=false', true, { email_verified: false }],
    ['email_verified="true" (string)', true, { email_verified: 'true' }],
    ['local user not verified', false, { email_verified: true }],
  ])(
    '§5.4 trusted provider + %s → not linked, no session',
    async (_name, localVerified, extra) => {
      const email = await passwordlessUser(admin, localVerified);
      const { res } = await idpLogin(app, claimsFor(email, extra));
      expect(errorOf(res)).toBe(NOT_LINKED);
      expect(setsSessionCookie(res)).toBe(false);
      expect(await providerAccounts(email)).toEqual([]);
      expect(await sessionCount(email)).toBe(0);
    },
  );

  it('§5.4 trusted provider + email_verified=true + verified local user → linked and signed in; OAuth tokens are encrypted at rest (criterion 11)', async () => {
    const email = await passwordlessUser(admin, true);
    const { c, res } = await idpLogin(
      app,
      claimsFor(email, { email_verified: true }),
    );
    expect(errorOf(res)).toBeNull();
    expect(location(res).pathname).toBe(CALLBACK_URL);
    expect(setsSessionCookie(res)).toBe(true);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    const [account] = await providerAccounts(email);
    const issued = idp.lastIssued();
    if (!account || !issued) throw new Error('no linked account or token');
    expect(account.access_token).toBeTruthy();
    expect(account.access_token).not.toContain(issued.accessToken);
    expect(account.id_token).toBeTruthy();
    expect(account.id_token).not.toContain(String(issued.idToken));
  });

  it('AUTH final review concern 3: trusted provider + an IdP email with surrounding spaces and upper case → linked to the EXISTING verified user and signed in', async () => {
    const email = await passwordlessUser(admin, true);
    const { c, res } = await idpLogin(
      app,
      claimsFor(`  ${email.toUpperCase()} `, { email_verified: true }),
    );
    expect(errorOf(res)).toBeNull();
    expect(setsSessionCookie(res)).toBe(true);
    expect(await accountProviders(email)).toEqual([PROVIDER]);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
  });

  it('S2-R49: an implicit IdP login onto a password account is refused; the owner links it explicitly via /link-social, then the IdP login signs in', async () => {
    const email = `p-${v7()}@example.test`;
    const owner = new AuthClient(app.getHttpServer());
    await owner.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    const claims = claimsFor(email, { email_verified: true });

    const implicit = await idpLogin(app, claims);
    expect(errorOf(implicit.res)).toBe(LINK_REFUSED);
    expect(setsSessionCookie(implicit.res)).toBe(false);
    expect(await accountProviders(email)).toEqual(['credential']);
    expect(await sessionCount(email)).toBe(0);

    expect((await owner.signIn(email, PASSWORD)).status).toBe(200);
    const linkCallback = await beginLogin(
      owner,
      claims,
      '/api/auth/link-social',
    );
    const linked = await owner.request('get', linkCallback);
    expect(errorOf(linked)).toBeNull();
    expect(location(linked).pathname).toBe(CALLBACK_URL);
    expect(await accountProviders(email)).toEqual(['corp', 'credential']);

    const again = await idpLogin(app, claims);
    expect(errorOf(again.res)).toBeNull();
    expect(setsSessionCookie(again.res)).toBe(true);
    expect(
      (await again.c.request('get', '/api/auth/get-session')).body?.user?.email,
    ).toBe(email);
  });

  it('S2-R48: a trusted-provider link made while the email was unverified is removed by the reclaim', async () => {
    const victim = `v-${v7()}@example.test`;
    // Provider tin cậy nhưng IdP nói email CHƯA xác thực: đăng ký mới được, user `emailVerified=false`.
    const { attacker, claims, started } = await preHijack(app, victim, false);
    const helper = new AuthClient(app.getHttpServer());
    expect(
      (await helper.verifyEmailFromMailpit(mail, victim, started)).status,
    ).toBeLessThan(400);
    expect(await isVerified(victim)).toBe(true);
    expect(await accountProviders(victim)).toEqual([]);
    expect(await sessionCount(victim)).toBe(0);
    expect((await attacker.request('get', '/api/auth/get-session')).body).toBe(
      null,
    );
    const { res } = await idpLogin(app, claims);
    expect(errorOf(res)).toBe(NOT_LINKED);
    expect(setsSessionCookie(res)).toBe(false);
    expect(await accountProviders(victim)).toEqual([]);
  });

  it.each<[string, IdTokenMode]>([
    ['signed by a key outside the IdP JWKS', 'foreign-key'],
    ['unsigned (alg none)', 'unsigned'],
    ['bound to another authorization request (nonce)', 'wrong-nonce'],
  ])(
    'S2-R37 discovered JWKS verification: an id_token %s is not trusted, its email_verified=true links nothing and creates no user',
    async (_name, mode) => {
      idp.setIdTokenMode(mode);
      const local = await passwordlessUser(admin, true);
      const onto = await idpLogin(
        app,
        claimsFor(local, { email_verified: true }),
      );
      expect(errorOf(onto.res)).toBe(NO_USER_INFO);
      expect(setsSessionCookie(onto.res)).toBe(false);
      expect(await providerAccounts(local)).toEqual([]);
      expect(await sessionCount(local)).toBe(0);

      const fresh = `n-${v7()}@example.test`;
      const created = await idpLogin(
        app,
        claimsFor(fresh, { email_verified: true }),
      );
      expect(errorOf(created.res)).toBe(NO_USER_INFO);
      expect(
        await ownerQuery(`SELECT 1 FROM auth."user" WHERE email = $1`, [fresh]),
      ).toEqual([]);
    },
  );
});

describe('OIDC provider registration at boot (S2-R37)', () => {
  afterEach(() => {
    idp.setPublishJwks(true);
    vi.unstubAllEnvs();
  });

  it('a discovery document without jwks_uri fails app boot with AuthProviderRegistrationError', async () => {
    idp.setPublishJwks(false);
    const app = await buildIdentityApp({ env: oidcEnv(PROVIDER) });
    try {
      await expect(app.init()).rejects.toBeInstanceOf(
        AuthProviderRegistrationError,
      );
    } finally {
      await app.close();
    }
  });
});

describe('OIDC sign-ups under a small auth pool (Task 34 N1)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // IdP xoay khoá trước lần xác minh đầu tiên của app: JWKS công bố cả hai khoá, `kid` chọn đúng khoá mới.
    await idp.rotateKeys();
    app = await startIdentityApp({
      env: oidcEnv(PROVIDER, { DB_AUTH_POOL_MAX: String(SMALL_AUTH_POOL) }),
    });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it(`${CONCURRENT_SIGN_UPS} concurrent OAuth sign-ups through the real callback all complete with DB_AUTH_POOL_MAX=${SMALL_AUTH_POOL}`, async () => {
    const flows = [];
    for (let i = 0; i < CONCURRENT_SIGN_UPS; i++) {
      const email = `c-${v7()}@example.test`;
      const c = new AuthClient(app.getHttpServer());
      const callback = await beginLogin(
        c,
        claimsFor(email, { email_verified: true }),
      );
      flows.push({ email, c, callback });
    }
    const results = await Promise.all(
      flows.map((f) => f.c.request('get', f.callback)),
    );
    for (const [i, res] of results.entries()) {
      const f = flows[i]!;
      expect(errorOf(res), f.email).toBeNull();
      expect(setsSessionCookie(res), f.email).toBe(true);
      expect(await accountProviders(f.email)).toEqual([PROVIDER]);
      expect(await isVerified(f.email)).toBe(true);
      expect(await userIdOf(f.email)).toBeTruthy();
    }
  });
});
