import { Logger, type INestApplication, Module } from '@nestjs/common';
import { runWithTransaction } from '@better-auth/core/context';
import { createEmailVerificationToken, isAPIError } from 'better-auth/api';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { URI } from 'otpauth';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseModule,
  databaseConfig,
} from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { FieldCipher } from '../../../src/core/security/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { AuthEmails } from '../../../src/modules/identity/application/auth-emails.js';
import {
  authDatabaseConfig,
  identityConfig,
  identityGuardConfig,
} from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import {
  VERIFIED_OWNER_ALLOWED,
  VERIFIED_OWNER_PATHS,
  createImplicitLinkGuard,
  createSessionFence,
  requiresVerifiedOwner,
} from '../../../src/modules/identity/infra/better-auth/auth-hooks.js';
import { AuthRequestState } from '../../../src/modules/identity/infra/better-auth/auth-request-state.js';
import {
  assertAuthProvidersRegistered,
  createAuthInstance,
  maskEmails,
  type AuthInstance,
  type AuthInstanceDeps,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { LoginLockout } from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import { UnverifiedLinkRevoker } from '../../../src/modules/identity/infra/better-auth/unverified-links.js';
import { PgIdentityDirectory } from '../../../src/modules/identity/infra/better-auth/pg-identity-directory.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const MAX_FAILURES = 3;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
const STALE = `interval '1 hour'`;
/** `iat` của JWT tính bằng giây. */
const JWT_IAT_RESOLUTION_MS = 1000;
/** Chờ sang giây kế tiếp: token phát sau đó có `iat` lớn hơn mọi mốc trước đó. */
const nextSecond = () =>
  new Promise((r) =>
    setTimeout(
      r,
      JWT_IAT_RESOLUTION_MS - (Date.now() % JWT_IAT_RESOLUTION_MS) + 10,
    ),
  );
@Module({ providers: [AuthEmails] })
class M {}

describe('Better Auth hooks against the real auth schema', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let owner: pg.Client;
  let auth: AuthInstance;
  let deps: AuthInstanceDeps;
  const state = new AuthRequestState();
  /** Mô phỏng cách `AuthMountMiddleware` gọi handler: `Request` dựng sẵn, IP do mình đặt. */
  const call = (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      cookie?: string;
      bearer?: string;
    } = {},
  ) =>
    auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: init.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-app-client-ip': `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        body:
          init.method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
      }),
    );
  const cookieOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  const notices = async (like: string) =>
    (
      await owner.query(
        `SELECT idempotency_key FROM email_deliveries WHERE idempotency_key LIKE $1`,
        [like],
      )
    ).rows.length;
  const idOf = async (email: string) =>
    (
      await owner.query<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email = $1`,
        [email],
      )
    ).rows[0]!.id;
  const verifiedUser = async () => {
    const email = `h-${v7()}@example.test`;
    await call('/sign-up/email', {
      body: { email, password: PASSWORD, name: 'H' },
    });
    await owner.query(
      `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
      [email],
    );
    return email;
  };
  const session = async (auth: { cookie?: string; bearer?: string }) =>
    (await call('/get-session', { method: 'GET', ...auth })).json();
  /**
   * Trạng thái mà một lần đăng nhập qua IdP KHÔNG tin cậy để lại (S2-R40): user email chưa xác thực (mapper ép
   * `emailVerified=false`), một dòng `account` của provider đó, một session đang sống. Token session không ký:
   * plugin `bearer` nhận cả token trần (`requireSignature` mặc định false).
   */
  const seedIdpUser = async (email: string, verified: boolean) => {
    const {
      rows: [u],
    } = await owner.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified) VALUES ('Idp', $1, $2) RETURNING id`,
      [email, verified],
    );
    const token = randomBytes(24).toString('hex');
    await owner.query(
      `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, 'corp', $2, now())`,
      [`sub-${v7()}`, u!.id],
    );
    await owner.query(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now())`,
      [token, u!.id],
    );
    return { id: u!.id, token };
  };
  const idpAccounts = async (userId: string) =>
    (
      await owner.query(
        `SELECT 1 FROM auth.account WHERE user_id = $1 AND provider_id = 'corp'`,
        [userId],
      )
    ).rows.length;

  beforeAll(async () => {
    vi.stubEnv('AUTH_LOCKOUT_MAX_FAILURES', String(MAX_FAILURES));
    vi.stubEnv('AUTH_SESSION_FRESH_AGE_SEC', '60');
    vi.stubEnv('AUTH_SIGNIN_RATE_MAX', '1000');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }),
      EventsModule.forRoot({ worker: false }),
      NotificationsModule.forApi(),
      M,
    ]);
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    const guard = identityGuardConfig();
    deps = {
      identity: identityConfig(),
      guard,
      app: { serviceName: 'svc' },
      corsOrigins: [ORIGIN],
      pool,
      cipher: new FieldCipher({ k1: randomBytes(32).toString('base64') }, 'k1'),
      lockout: new LoginLockout(pool, {
        maxFailures: guard.lockoutMaxFailures,
        windowSec: guard.lockoutWindowSec,
        blockSec: guard.lockoutBlockSec,
      }),
      emails: app.get(AuthEmails),
      directory: new PgIdentityDirectory(pool),
      state,
      onUserCreated: async () => undefined,
      inAppTransaction: () => false,
      requestId: () => 'r-hooks',
      problemTypeBase: '/errors',
      logger: new Logger('better-auth'),
    };
    auth = createAuthInstance(deps);
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
    await pool?.end();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('sign-up: new and existing email get byte-identical 202 responses; the owner gets one notice', async () => {
    const email = `s-${v7()}@example.test`;
    const shape = async (r: Response) => ({
      status: r.status,
      body: await r.text(),
      cookies: r.headers.getSetCookie(),
    });
    const first = await shape(
      await call('/sign-up/email', {
        body: { email, password: PASSWORD, name: 'S' },
      }),
    );
    const again = await shape(
      await call('/sign-up/email', {
        body: { email, password: PASSWORD, name: 'S' },
      }),
    );
    expect(first).toEqual({ status: 202, body: '', cookies: [] });
    expect(again).toEqual(first);
    expect(await notices(`existing-account:${await idOf(email)}:%`)).toBe(1);
  });

  it('emails are normalized before Better Auth validates them (case + surrounding spaces)', async () => {
    const email = `n-${v7()}@example.test`;
    expect(
      (
        await call('/sign-up/email', {
          body: {
            email: `  ${email.toUpperCase()} `,
            password: PASSWORD,
            name: 'N',
          },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await owner.query(`SELECT email FROM auth."user" WHERE email = $1`, [
          email,
        ])
      ).rows,
    ).toHaveLength(1);
    await owner.query(
      `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
      [email],
    );
    expect(
      (
        await call('/sign-in/email', {
          body: { email: ` ${email.toUpperCase()}`, password: PASSWORD },
        })
      ).status,
    ).toBe(200);
  });

  it('concurrent sign-ups with the same email all answer 202 and create exactly one user (FAILED_TO_CREATE_USER is treated as "exists")', async () => {
    const email = `race-${v7()}@example.test`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('/sign-up/email', {
          body: { email, password: PASSWORD, name: 'R' },
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM auth."user" WHERE email = $1`,
          [email],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('a malformed sign-up (no name, bad email) stays an error, never the generic 202 (isAPIError covers better-call errors)', async () => {
    const r = await call('/sign-up/email', {
      body: { email: 'not-an-email', password: PASSWORD },
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('S2-R39: a user-supplied name with CR/LF or over 200 characters is a validation problem on field name', async () => {
    for (const name of ['Eve\r\nBcc: x', 'n'.repeat(201)]) {
      const signUp = await call('/sign-up/email', {
        body: { email: `nm-${v7()}@example.test`, password: PASSWORD, name },
      });
      expect(signUp.status).toBe(422);
      expect(signUp.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      expect(await signUp.json()).toMatchObject({
        code: 'validation_failed',
        errors: [expect.objectContaining({ path: 'name' })],
      });
    }
    const email = await verifiedUser();
    const c = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    const update = await call('/update-user', {
      cookie: c,
      body: { name: 'a\nb' },
    });
    expect(update.status).toBe(422);
    expect(
      (
        await owner.query(`SELECT name FROM auth."user" WHERE email = $1`, [
          email,
        ])
      ).rows[0].name,
    ).toBe('H');
    expect(
      (
        await call('/update-user', {
          cookie: c,
          body: { name: 'n'.repeat(200) },
        })
      ).status,
    ).toBe(200);
  });

  it('S2-R39: an IdP-sourced name is sanitised by the database hooks (CR/LF → space, capped at 200)', async () => {
    const ctx = await auth.$context;
    const email = `idp-${v7()}@example.test`;
    const user = await ctx.internalAdapter.createUser(
      {
        email,
        name: `Mallory\r\nBcc: victim${'x'.repeat(300)}`,
        emailVerified: false,
      },
      { method: 'oauth', oauth: { providerId: 'corp' } },
    );
    const stored = (
      await owner.query<{ name: string }>(
        `SELECT name FROM auth."user" WHERE id = $1`,
        [user.id],
      )
    ).rows[0]!.name;
    expect(stored).toHaveLength(200);
    expect(stored).not.toMatch(/[\r\n]/);
    expect(stored.startsWith('Mallory Bcc: victim')).toBe(true);
    await ctx.internalAdapter.updateUser(user.id, { name: 'A\rB' });
    expect(
      (
        await owner.query(`SELECT name FROM auth."user" WHERE id = $1`, [
          user.id,
        ])
      ).rows[0].name,
    ).toBe('A B');
  });

  it('wrong password → 401 with the Better Auth code (mapping to problem+json happens in the mount, Task 36)', async () => {
    const email = await verifiedUser();
    const r = await call('/sign-in/email', {
      body: { email, password: 'wrong-password-123' },
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  });

  it('lockout: after MAX failures the account answers problem+json 429 with Retry-After without verifying; a success refunds', async () => {
    const email = await verifiedUser();
    for (let i = 0; i < MAX_FAILURES - 1; i++)
      await call('/sign-in/email', {
        body: { email, password: 'nope-nope-nope' },
      });
    expect(
      (await call('/sign-in/email', { body: { email, password: PASSWORD } }))
        .status,
    ).toBe(200);
    await call('/sign-in/email', {
      body: { email, password: 'nope-nope-nope' },
    });
    await call('/sign-in/email', {
      body: { email, password: 'nope-nope-nope' },
    });
    const blocked = await call('/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    expect([blocked.status, blocked.headers.get('content-type')]).toEqual([
      429,
      expect.stringContaining('application/problem+json'),
    ]);
    expect(await blocked.json()).toMatchObject({
      code: 'rate_limited',
      // M2: cùng `instance` với `ProblemDetailsFilter` (path của request, không query).
      instance: '/api/auth/sign-in/email',
    });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('lockout storage failure → 503 problem+json with Retry-After, never 500', async () => {
    const email = await verifiedUser();
    await owner.query(
      'REVOKE INSERT, UPDATE ON auth.login_attempts FROM auth_user',
    );
    try {
      const r = await call('/sign-in/email', {
        body: { email, password: PASSWORD },
      });
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBe(
        String(identityGuardConfig().unavailableRetryAfterSec),
      );
    } finally {
      await owner.query(
        'GRANT INSERT, UPDATE ON auth.login_attempts TO auth_user',
      );
    }
  });

  it('a server-side auth.api call (not through the mount) keeps its own request state: a verified sign-in is refunded', async () => {
    const email = await verifiedUser();
    for (let i = 0; i < MAX_FAILURES - 1; i++)
      await call('/sign-in/email', {
        body: { email, password: 'nope-nope-nope' },
      });
    // MAX-1 lần sai + lần đúng này = MAX điểm; nếu lần này không được hoàn, lần đúng tiếp theo là MAX+1 → 429.
    await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      headers: new Headers({ origin: ORIGIN }),
    });
    expect(
      (await call('/sign-in/email', { body: { email, password: PASSWORD } }))
        .status,
    ).toBe(200);
  });

  it('change-password always revokes other sessions, even if the client asks not to', async () => {
    const email = await verifiedUser();
    const a = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    const b = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    const r = await call('/change-password', {
      cookie: a,
      body: {
        currentPassword: PASSWORD,
        newPassword: 'a brand new passphrase',
        revokeOtherSessions: false,
      },
    });
    expect(r.status).toBe(200);
    expect(await session({ cookie: b })).toBeNull();
  });

  it('notif-M1: the 4 base64url encodings of the last signature character are one confirmation token: one email, not four', async () => {
    const email = await verifiedUser();
    const newEmail = `enc-${v7()}@example.test`;
    const secret = identityConfig().secret;
    if (!secret)
      throw new Error('BETTER_AUTH_SECRET is not set in the test env');
    const token = await createEmailVerificationToken(
      secret,
      email,
      newEmail,
      3600,
      { requestType: 'change-email-confirmation' },
    );
    // Ký tự cuối của chữ ký HS256 (43 ký tự) mang 2 bit thừa: 4 cách viết cùng một chữ ký.
    const base64url =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const cut = token.length - 1;
    const index = base64url.indexOf(token.charAt(cut));
    expect(index).toBeGreaterThanOrEqual(0);
    const variants = [0, 1, 2, 3].map(
      (low) =>
        `${token.slice(0, cut)}${base64url.charAt(index - (index % 4) + low)}`,
    );
    expect(new Set(variants).size).toBe(4);
    const before = await notices('verify-email:once:%');
    for (const v of variants)
      expect(
        (await call(`/verify-email?token=${v}`, { method: 'GET' })).status,
        v,
      ).toBe(200);
    expect(await notices('verify-email:once:%')).toBe(before + 1);
  });

  it('a stale session gets 403 reauthentication_required on sensitive operations', async () => {
    const email = await verifiedUser();
    const c = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    await owner.query(
      `UPDATE auth.session SET created_at = now() - ${STALE} WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email],
    );
    const r = await call('/change-password', {
      cookie: c,
      body: { currentPassword: PASSWORD, newPassword: 'another passphrase ok' },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'reauthentication_required' });
  });

  it('a stale BEARER session is also refused (the bearer plugin converts the header only after our hook runs)', async () => {
    const email = await verifiedUser();
    const signIn = await call('/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    const token = signIn.headers.get('set-auth-token');
    expect(token).toBeTruthy();
    await owner.query(
      `UPDATE auth.session SET created_at = now() - ${STALE} WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email],
    );
    const r = await call('/change-password', {
      bearer: token!,
      body: { currentPassword: PASSWORD, newPassword: 'another passphrase ok' },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'reauthentication_required' });
  });

  it('S2-R38: a stale session cannot start /change-email (403 before any lookup or notice)', async () => {
    const taken = await verifiedUser();
    const email = await verifiedUser();
    const c = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    await owner.query(
      `UPDATE auth.session SET created_at = now() - ${STALE} WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email],
    );
    const r = await call('/change-email', {
      cookie: c,
      body: { newEmail: taken },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'reauthentication_required' });
    expect(await notices(`existing-account:${await idOf(taken)}:%`)).toBe(0);
  });

  it('change-email ANONYMOUS: taken and free targets give the same 401, and nobody is notified (no oracle)', async () => {
    const taken = await verifiedUser();
    const before = await notices(`existing-account:${await idOf(taken)}:%`);
    const shape = async (r: Response) => ({
      status: r.status,
      body: (await r.text()).replace(
        /"requestId":"[^"]*"|"timestamp":"[^"]*"/g,
        '',
      ),
    });
    const a = await shape(
      await call('/change-email', { body: { newEmail: taken } }),
    );
    const b = await shape(
      await call('/change-email', {
        body: { newEmail: `free-${v7()}@example.test` },
      }),
    );
    expect(a.status).toBe(401);
    expect(b).toEqual(a);
    expect(await notices(`existing-account:${await idOf(taken)}:%`)).toBe(
      before,
    );
  });

  it('S2-R66: change-email by a VERIFIED user sends the old-address confirmation for a taken target too, and notifies nobody yet', async () => {
    const taken = await verifiedUser();
    const email = await verifiedUser();
    const c = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    const confirmations = () => notices('change-email-confirmation:%');
    const before = await confirmations();
    const r = await call('/change-email', {
      cookie: c,
      body: { newEmail: ` ${taken.toUpperCase()}` },
    });
    expect([r.status, await r.text()]).toEqual([202, '']);
    expect(await confirmations()).toBe(before + 1);
    // Thông báo cho chủ địa chỉ đích chỉ gửi khi link xác nhận được bấm (auth-instance `sendVerificationEmail`).
    expect(await notices(`existing-account:${await idOf(taken)}:%`)).toBe(0);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM auth."user" WHERE email = $1`,
          [email],
        )
      ).rows[0].n,
    ).toBe(1);
    const free = await call('/change-email', {
      cookie: c,
      body: { newEmail: `free-${v7()}@example.test` },
    });
    expect([free.status, await free.text()]).toEqual([202, '']);
    expect(await confirmations()).toBe(before + 2);
  });

  it('S2-R76 (C2): change-email by an UNVERIFIED session is refused with 403 email_not_verified; no token, no notice, no confirmation (the one-step branch is closed)', async () => {
    const taken = await verifiedUser();
    const unverified = await seedIdpUser(`uv-${v7()}@example.test`, false);
    const before = {
      confirmations: await notices('change-email-confirmation:%'),
      verifications: await notices('verify-email:%'),
    };
    for (const newEmail of [taken, `free-${v7()}@example.test`]) {
      const r = await call('/change-email', {
        bearer: unverified.token,
        body: { newEmail },
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'email_not_verified' });
    }
    expect(await notices(`existing-account:${await idOf(taken)}:%`)).toBe(0);
    expect({
      confirmations: await notices('change-email-confirmation:%'),
      verifications: await notices('verify-email:%'),
    }).toEqual(before);
  });

  it('2FA notice: none on /two-factor/enable, one "enabled" notice once the first TOTP verification turns it on, one "disabled" notice on disable', async () => {
    const email = await verifiedUser();
    const id = await idOf(email);
    const c = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    const en = await call('/two-factor/enable', {
      cookie: c,
      body: { password: PASSWORD },
    });
    expect(en.status).toBe(200);
    expect(await notices(`two-factor-changed:${id}:%`)).toBe(0);
    const totp = URI.parse((await en.json()).totpURI);
    const verified = await call('/two-factor/verify-totp', {
      cookie: c,
      body: { code: totp.generate() },
    });
    expect(verified.status).toBe(200);
    expect(await notices(`two-factor-changed:${id}:%:enabled`)).toBe(1);
    // verify-totp thay session (xoá session cũ, phát cookie mới).
    const rotated = cookieOf(verified);
    // M8 (âm): verify-totp khi 2FA ĐÃ bật (session mới, key thông báo khác) không được báo lần nữa.
    const again = await call('/two-factor/verify-totp', {
      cookie: rotated,
      body: { code: totp.generate() },
    });
    expect(again.status).toBe(200);
    expect(await notices(`two-factor-changed:${id}:%:enabled`)).toBe(1);
    const off = await call('/two-factor/disable', {
      cookie: rotated,
      body: { password: PASSWORD },
    });
    expect(off.status).toBe(200);
    expect(await notices(`two-factor-changed:${id}:%:disabled`)).toBe(1);
  });

  it('S2-R40: a password reset reclaims an account pre-registered through an untrusted IdP (IdP link removed, attacker session revoked)', async () => {
    const email = `victim-${v7()}@example.test`;
    const attacker = await seedIdpUser(email, false);
    expect(await session({ bearer: attacker.token })).not.toBeNull();
    expect(
      (
        await call('/request-password-reset', {
          body: { email, redirectTo: '/reset' },
        })
      ).status,
    ).toBe(200);
    const {
      rows: [v],
    } = await owner.query<{ identifier: string }>(
      `SELECT identifier FROM auth.verification WHERE value = $1 AND identifier LIKE 'reset-password:%'`,
      [attacker.id],
    );
    const token = v!.identifier.slice('reset-password:'.length);
    expect(
      (
        await call('/reset-password', {
          body: { token, newPassword: 'victim takes it back' },
        })
      ).status,
    ).toBe(200);
    expect(await idpAccounts(attacker.id)).toBe(0);
    expect(await session({ bearer: attacker.token })).toBeNull();
  });

  it('S2-R40: the verification link does the same; a reset on an already verified account keeps its links', async () => {
    const email = `victim2-${v7()}@example.test`;
    const attacker = await seedIdpUser(email, false);
    const secret = identityConfig().secret;
    if (!secret)
      throw new Error('BETTER_AUTH_SECRET is not set in the test env');
    const token = await createEmailVerificationToken(secret, email);
    const r = await call(`/verify-email?token=${token}`, { method: 'GET' });
    expect(r.status).toBe(200);
    expect(await idpAccounts(attacker.id)).toBe(0);
    expect(await session({ bearer: attacker.token })).toBeNull();
    expect(
      (
        await owner.query(
          `SELECT email_verified FROM auth."user" WHERE id = $1`,
          [attacker.id],
        )
      ).rows[0].email_verified,
    ).toBe(true);

    const linkedEmail = `linked-${v7()}@example.test`;
    const linked = await seedIdpUser(linkedEmail, true);
    await call('/request-password-reset', {
      body: { email: linkedEmail, redirectTo: '/reset' },
    });
    const {
      rows: [lv],
    } = await owner.query<{ identifier: string }>(
      `SELECT identifier FROM auth.verification WHERE value = $1 AND identifier LIKE 'reset-password:%'`,
      [linked.id],
    );
    expect(
      (
        await call('/reset-password', {
          body: {
            token: lv!.identifier.slice('reset-password:'.length),
            newPassword: 'verified user resets',
          },
        })
      ).status,
    ).toBe(200);
    expect(await idpAccounts(linked.id)).toBe(1);
  });

  it('S2-R40 / I2: a change-email verification link that verifies an unverified IdP account reclaims it too', async () => {
    const attackerEmail = `att-${v7()}@example.test`;
    const victimEmail = `vic-${v7()}@example.test`;
    const attacker = await seedIdpUser(attackerEmail, false);
    const secret = identityConfig().secret;
    if (!secret)
      throw new Error('BETTER_AUTH_SECRET is not set in the test env');
    // Link mà Better Auth gửi tới địa chỉ MỚI (`update-user.mjs`, nhánh change-email-verification).
    const token = await createEmailVerificationToken(
      secret,
      attackerEmail,
      victimEmail,
      3600,
      { requestType: 'change-email-verification' },
    );
    const r = await call(`/verify-email?token=${token}`, { method: 'GET' });
    expect(r.status).toBe(200);
    const row = (
      await owner.query<{ email: string; email_verified: boolean }>(
        `SELECT email, email_verified FROM auth."user" WHERE id = $1`,
        [attacker.id],
      )
    ).rows[0];
    expect(row).toEqual({ email: victimEmail, email_verified: true });
    expect(await idpAccounts(attacker.id)).toBe(0);
    expect(await session({ bearer: attacker.token })).toBeNull();
  });

  describe('S2-R76: an unverified-email session cannot mint credentials or change identity', () => {
    type Endpoint = { path?: unknown; options?: { method?: unknown } };
    /** Path + method HTTP của mọi endpoint của instance (endpoint server-only không có path). */
    const httpEndpoints = (): { path: string; method: string }[] =>
      Object.values(auth.api as Record<string, Endpoint>).flatMap((e) => {
        const m = e.options?.method;
        const method: unknown = Array.isArray(m) ? m[0] : m;
        return typeof e.path === 'string' && typeof method === 'string'
          ? [{ path: e.path, method: method === '*' ? 'POST' : method }]
          : [];
      });
    const tokenOfVerified = async () => {
      const email = await verifiedUser();
      const signIn = await call('/sign-in/email', {
        body: { email, password: PASSWORD },
      });
      const token = signIn.headers.get('set-auth-token');
      if (!token) throw new Error('no bearer token on sign-in');
      return token;
    };

    it('drift: every HTTP endpoint of better-auth 1.7.6 + plugins is classified (gated or explicitly allowed)', () => {
      const paths = httpEndpoints().map((e) => e.path);
      expect(
        paths.filter(
          (p) => !requiresVerifiedOwner(p) && !VERIFIED_OWNER_ALLOWED.has(p),
        ),
      ).toEqual([]);
      // Both lists name only real endpoints (a typo would silently gate or allow nothing).
      const known = new Set(paths);
      expect([...VERIFIED_OWNER_PATHS].filter((p) => !known.has(p))).toEqual(
        [],
      );
      expect([...VERIFIED_OWNER_ALLOWED].filter((p) => !known.has(p))).toEqual(
        [],
      );
    });

    it('every gated endpoint answers 403 email_not_verified to an unverified session and never to a verified one', async () => {
      // `disabledPaths` (impersonation, D7) answer 404 at the router, before any hook.
      const disabled = new Set<string>(auth.options.disabledPaths);
      const gated = httpEndpoints().filter(
        (e) => requiresVerifiedOwner(e.path) && !disabled.has(e.path),
      );
      expect(gated.map((e) => e.path)).toEqual(
        expect.arrayContaining([
          '/api-key/create',
          '/change-email',
          '/token',
          '/two-factor/enable',
        ]),
      );
      const verified = await tokenOfVerified();
      for (const e of gated) {
        const unverified = await seedIdpUser(`g-${v7()}@example.test`, false);
        const refused = await call(e.path, {
          method: e.method,
          bearer: unverified.token,
        });
        expect([refused.status, (await refused.json()).code], e.path).toEqual([
          403,
          'email_not_verified',
        ]);
        const ok = await call(e.path, { method: e.method, bearer: verified });
        const body: unknown = await ok.json().catch(() => null);
        const code =
          typeof body === 'object' && body !== null && 'code' in body
            ? body.code
            : undefined;
        expect(code, e.path).not.toBe('email_not_verified');
      }
    });

    it('the verification flow, get-session and sign-out stay open to an unverified session', async () => {
      const email = `open-${v7()}@example.test`;
      const u = await seedIdpUser(email, false);
      expect((await session({ bearer: u.token }))?.user?.email).toBe(email);
      const send = await call('/send-verification-email', {
        bearer: u.token,
        body: { email },
      });
      expect(send.status).toBe(200);
      expect((await call('/sign-out', { bearer: u.token })).status).toBe(200);
      expect(await session({ bearer: u.token })).toBeNull();
    });

    it('C1: the reclaim also revokes API keys that exist before verification, and records the durable reclaim marker', async () => {
      const email = `ck-${v7()}@example.test`;
      const attacker = await seedIdpUser(email, false);
      // A key minted while the email was unverified (before S2-R76 an unverified session could; server-side still can).
      await auth.api.createApiKey({ body: { userId: attacker.id } });
      const keys = async () =>
        (
          await owner.query(
            `SELECT 1 FROM auth.apikey WHERE reference_id = $1`,
            [attacker.id],
          )
        ).rows.length;
      const marker = async () =>
        (
          await owner.query<{ reclaimed_at: Date }>(
            `SELECT reclaimed_at FROM auth.user_reclaim WHERE user_id = $1`,
            [attacker.id],
          )
        ).rows[0]?.reclaimed_at;
      expect(await keys()).toBe(1);
      expect(await marker()).toBeUndefined();
      const secret = identityConfig().secret;
      if (!secret)
        throw new Error('BETTER_AUTH_SECRET is not set in the test env');
      const token = await createEmailVerificationToken(secret, email);
      const before = Date.now();
      expect(
        (await call(`/verify-email?token=${token}`, { method: 'GET' })).status,
      ).toBe(200);
      expect(await keys()).toBe(0);
      expect((await marker())?.getTime()).toBeGreaterThanOrEqual(
        before - JWT_IAT_RESOLUTION_MS,
      );
      expect(await idpAccounts(attacker.id)).toBe(0);
    });

    it('C2: /verify-email refuses an email-change token issued before the reclaim (no session, no email change); one issued afterwards still works', async () => {
      const victim = `vc-${v7()}@example.test`;
      const attackerEmail = `ae-${v7()}@example.test`;
      const attacker = await seedIdpUser(victim, false);
      const secret = identityConfig().secret;
      if (!secret)
        throw new Error('BETTER_AUTH_SECRET is not set in the test env');
      // What the pre-S2-R76 one-step branch mailed to the attacker (`update-user.mjs`, change-email-verification).
      const stale = await createEmailVerificationToken(
        secret,
        victim,
        attackerEmail,
        3600,
        { requestType: 'change-email-verification' },
      );
      await nextSecond();
      const proof = await createEmailVerificationToken(secret, victim);
      expect(
        (await call(`/verify-email?token=${proof}`, { method: 'GET' })).status,
      ).toBe(200);
      const sessions = async () =>
        (
          await owner.query(`SELECT 1 FROM auth.session WHERE user_id = $1`, [
            attacker.id,
          ])
        ).rows.length;
      const sessionsBefore = await sessions();
      const refused = await call(`/verify-email?token=${stale}`, {
        method: 'GET',
      });
      expect([refused.status, (await refused.json()).code]).toEqual([
        400,
        'invalid_or_expired_token',
      ]);
      expect(refused.headers.getSetCookie()).toEqual([]);
      const emailOf = async () =>
        (
          await owner.query<{ email: string }>(
            `SELECT email FROM auth."user" WHERE id = $1`,
            [attacker.id],
          )
        ).rows[0]?.email;
      expect(await emailOf()).toBe(victim);
      expect(await sessions()).toBe(sessionsBefore);

      // A token issued after the reclaim (the owner's own later change) is not affected.
      await nextSecond();
      const fresh = await createEmailVerificationToken(
        secret,
        victim,
        attackerEmail,
        3600,
        { requestType: 'change-email-verification' },
      );
      expect(
        (await call(`/verify-email?token=${fresh}`, { method: 'GET' })).status,
      ).toBe(200);
      expect(await emailOf()).toBe(attackerEmail);
    });
  });

  describe('S2-R44 / I1: a session written by an in-flight untrusted-IdP login after the reclaim is fenced', () => {
    const sessionIdOf = async (token: string) =>
      (
        await owner.query<{ id: string }>(
          `SELECT id FROM auth.session WHERE token = $1`,
          [token],
        )
      ).rows[0]?.id;
    /** Barrier: chờ tới khi có một backend đang ĐỢI khoá trên `auth."user"` (thứ tự do khoá quyết, không do thời gian). */
    // Chờ khoá dòng hiện ra trong `pg_locks` là một khoá `transactionid` CHƯA cấp trên xid của bên giữ khoá (ở đây là
    // transaction reclaim), nên barrier khớp đúng xid đó, không lẫn với test khác. Có trần số vòng để lỗi to thay vì treo.
    const MAX_POLLS = 10_000;
    const waitForLockWait = async (holderXids: readonly string[]) => {
      for (let i = 0; i < MAX_POLLS; i++) {
        const { rows } = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'transactionid' AND transactionid::text = ANY($1) AND NOT granted`,
          [holderXids],
        );
        if (rows[0]!.n > 0) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('nobody ever waited on the given transactions');
    };

    it('reclaim commits while the fence waits on the user row: the fence sees the link gone and deletes the late session', async () => {
      const revoker = new UnverifiedLinkRevoker(pool);
      const attacker = await seedIdpUser(`late-${v7()}@example.test`, false);
      const late = await sessionIdOf(attacker.token);
      const { pg: p } = getInfra();
      const reclaim = new pg.Client({
        host: p.host,
        port: p.port,
        database: p.database,
        ...p.owner,
      });
      await reclaim.connect();
      try {
        // Reclaim đang chạy dở: khoá dòng user, đã gỡ link, chưa commit.
        await reclaim.query('BEGIN');
        await reclaim.query(
          `SELECT 1 FROM auth."user" WHERE id = $1 FOR UPDATE`,
          [attacker.id],
        );
        await reclaim.query(
          `DELETE FROM auth.account WHERE user_id = $1 AND provider_id = 'corp'`,
          [attacker.id],
        );
        const {
          rows: [xid],
        } = await reclaim.query<{ xid: string }>(
          `SELECT transactionid::text AS xid FROM pg_locks
            WHERE pid = pg_backend_pid() AND locktype = 'transactionid'`,
        );
        const fenced = revoker.fenceLateSession(
          { id: late!, userId: attacker.id },
          'corp',
        );
        await waitForLockWait([xid!.xid]);
        await reclaim.query('COMMIT');
        expect(await fenced).toBe(true);
      } finally {
        await reclaim.end();
      }
      expect(await sessionIdOf(attacker.token)).toBeUndefined();
      expect(await session({ bearer: attacker.token })).toBeNull();
    });

    it('a login whose provider link still exists keeps its session; the hook is wired into the instance', async () => {
      const revoker = new UnverifiedLinkRevoker(pool);
      const user = await seedIdpUser(`kept-${v7()}@example.test`, false);
      const id = await sessionIdOf(user.token);
      expect(
        await revoker.fenceLateSession({ id: id!, userId: user.id }, 'corp'),
      ).toBe(false);
      expect(await sessionIdOf(user.token)).toBe(id);
      expect(typeof auth.options.databaseHooks.session?.create?.after).toBe(
        'function',
      );
    });

    it('R1: the REAL revoke() against two in-flight IdP session INSERTs leaves no session alive', async () => {
      const revoker = new UnverifiedLinkRevoker(pool);
      const email = `r1-${v7()}@example.test`;
      const {
        rows: [u],
      } = await owner.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified) VALUES ('Idp', $1, false) RETURNING id`,
        [email],
      );
      const userId = u!.id;
      await owner.query(
        `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, 'corp', $2, now())`,
        [`sub-${v7()}`, userId],
      );
      const { pg: p } = getInfra();
      const connect = async () => {
        const c = new pg.Client({
          host: p.host,
          port: p.port,
          database: p.database,
          ...p.owner,
        });
        await c.connect();
        return c;
      };
      /** Một lần đăng nhập IdP đang dở: đã INSERT session (FK giữ `FOR KEY SHARE` trên user), chưa commit. */
      const inFlight = async () => {
        const c = await connect();
        await c.query('BEGIN');
        const {
          rows: [s],
        } = await c.query<{ id: string }>(
          `INSERT INTO auth.session (token, user_id, expires_at, updated_at)
           VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
          [randomBytes(24).toString('hex'), userId],
        );
        const {
          rows: [x],
        } = await c.query<{ xid: string }>(
          `SELECT transactionid::text AS xid FROM pg_locks
            WHERE pid = pg_backend_pid() AND locktype = 'transactionid'`,
        );
        return { client: c, sessionId: s!.id, xid: x!.xid };
      };
      const l1 = await inFlight();
      const l2 = await inFlight();
      try {
        // 1. Reclaim bắt đầu và XẾP HÀNG sau hai INSERT (barrier: chờ khoá trên xid của L1 hoặc L2).
        const reclaim = revoker.revoke(userId, 'email-verification');
        await waitForLockWait([l1.xid, l2.xid]);
        // 2. L1 commit; hàng rào của L1 chạy NGAY (không có sleep) trong khi reclaim còn chờ L2.
        await l1.client.query('COMMIT');
        // F1 VƯỢT lên trước reclaim còn đang chờ L2: liên kết vẫn còn, nên nó KHÔNG xoá (reclaim sẽ xoá).
        expect(
          await revoker.fenceLateSession({ id: l1.sessionId, userId }, 'corp'),
        ).toBe(false);
        // 3. L2 commit, reclaim chạy xong; rồi hàng rào của L2.
        await l2.client.query('COMMIT');
        await reclaim;
        // F2 chạy sau commit của reclaim: session đã bị chính reclaim xoá. Lần đăng nhập L2 hoàn tất SAU reclaim nên
        // vẫn phải bị từ chối (Task 39: không cấp cookie của session đã chết kèm redirect thành công) → `true`.
        expect(
          await revoker.fenceLateSession({ id: l2.sessionId, userId }, 'corp'),
        ).toBe(true);
      } finally {
        await l1.client.end();
        await l2.client.end();
      }
      expect(
        (
          await owner.query(`SELECT id FROM auth.session WHERE user_id = $1`, [
            userId,
          ])
        ).rows,
      ).toEqual([]);
      expect(await idpAccounts(userId)).toBe(0);
    });

    it('R2: when the fence deletes the session it throws a 401 APIError (callback and idToken sign-in), so no cookie is issued', async () => {
      const revoker = new UnverifiedLinkRevoker(pool);
      const fence = createSessionFence(revoker);
      for (const ctx of [
        { path: '/callback/:id', params: { id: 'corp' } },
        { path: '/sign-in/social', body: { provider: 'corp' } },
      ]) {
        const user = await seedIdpUser(`r2-${v7()}@example.test`, false);
        const id = await sessionIdOf(user.token);
        await owner.query(`DELETE FROM auth.account WHERE user_id = $1`, [
          user.id,
        ]);
        const err = await fence({ id: id!, userId: user.id }, ctx).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isAPIError(err)).toBe(true);
        expect(err).toMatchObject({
          statusCode: 401,
          body: { code: 'OAUTH_SESSION_REVOKED' },
        });
        expect(await sessionIdOf(user.token)).toBeUndefined();
      }
      // Session không đến từ OAuth: không đụng tới.
      const plain = await seedIdpUser(`r2p-${v7()}@example.test`, false);
      await owner.query(`DELETE FROM auth.account WHERE user_id = $1`, [
        plain.id,
      ]);
      const plainId = await sessionIdOf(plain.token);
      await fence(
        { id: plainId!, userId: plain.id },
        { path: '/sign-in/email' },
      );
      expect(await sessionIdOf(plain.token)).toBe(plainId);
    });
  });

  it('S2-R48: a reclaim keeps ONLY the credential account (a trusted-provider link made while unverified is removed too)', async () => {
    const email = `r48-${v7()}@example.test`;
    const user = await seedIdpUser(email, false);
    await owner.query(
      `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at)
       VALUES ($1::text, 'google', $1::uuid, now()), ($1::text, 'credential', $1::uuid, now())`,
      [user.id],
    );
    await new UnverifiedLinkRevoker(pool).revoke(user.id, 'password-reset');
    expect(
      (
        await owner.query<{ provider_id: string }>(
          `SELECT provider_id FROM auth.account WHERE user_id = $1`,
          [user.id],
        )
      ).rows.map((r) => r.provider_id),
    ).toEqual(['credential']);
    expect(await session({ bearer: user.token })).toBeNull();
  });

  describe('S2-R49: no implicit provider link onto a password account', () => {
    const accountsOf = async (userId: string) =>
      (
        await owner.query<{ provider_id: string }>(
          `SELECT provider_id FROM auth.account WHERE user_id = $1 ORDER BY provider_id`,
          [userId],
        )
      ).rows.map((r) => r.provider_id);

    it('Better Auth linkAccount (the implicit-link path) is refused for a user with a password, allowed for one without', async () => {
      const ctx = await auth.$context;
      const withPassword = await idOf(await verifiedUser());
      expect(
        await ctx.internalAdapter.linkAccount({
          userId: withPassword,
          providerId: 'google',
          accountId: `g-${v7()}`,
        }),
      ).toBeNull();
      expect(await accountsOf(withPassword)).toEqual(['credential']);

      const oauthOnly = await seedIdpUser(`r49-${v7()}@example.test`, true);
      expect(
        await ctx.internalAdapter.linkAccount({
          userId: oauthOnly.id,
          providerId: 'google',
          accountId: `g-${v7()}`,
        }),
      ).not.toBeNull();
      expect(await accountsOf(oauthOnly.id)).toEqual(['corp', 'google']);
    });

    it('N1: a first-time OAuth sign-up (user + account in ONE Better Auth transaction) completes on an auth pool of max 1', async () => {
      const small = createAuthPool(
        { ...authDatabaseConfig(), poolMax: 1, connectionTimeoutMs: 2000 },
        databaseConfig(),
      );
      try {
        const guard = identityGuardConfig();
        const inst = createAuthInstance({
          ...deps,
          pool: small,
          lockout: new LoginLockout(small, {
            maxFailures: guard.lockoutMaxFailures,
            windowSec: guard.lockoutWindowSec,
            blockSec: guard.lockoutBlockSec,
          }),
          directory: new PgIdentityDirectory(small),
        });
        const ctx = await inst.$context;
        const email = `n1-${v7()}@example.test`;
        // Cùng hình dạng với `handleOAuthUserInfo` khi đăng ký (`oauth2/link-account.mjs:274-289`): các hook
        // `user.create.before`, `account.create.before` (S2-R49) chạy khi transaction đang giữ connection DUY NHẤT.
        const userId = await runWithTransaction(ctx.adapter, async () => {
          const user = await ctx.internalAdapter.createUser(
            { email, name: 'Oauth\nUser', emailVerified: false },
            { method: 'oauth', oauth: { providerId: 'corp' } },
          );
          const account = await ctx.internalAdapter.linkAccount({
            userId: user.id,
            providerId: 'corp',
            accountId: `sub-${v7()}`,
          });
          expect(account).not.toBeNull();
          return user.id;
        });
        // Session ngoài transaction: `session.create.after` (hàng rào) chạy sau đó trên pool một connection.
        expect(await ctx.internalAdapter.createSession(userId)).not.toBeNull();
        expect(await accountsOf(userId)).toEqual(['corp']);
        expect(
          (
            await owner.query<{ name: string }>(
              `SELECT name FROM auth."user" WHERE id = $1`,
              [userId],
            )
          ).rows[0]!.name,
        ).toBe('Oauth User');
      } finally {
        await small.end();
      }
    });

    it('explicit links (/link-social idToken, callback with OAuth state `link`) are allowed; an implicit callback link is refused', async () => {
      const userId = await idOf(await verifiedUser());
      const ctx = await auth.$context;
      const credentials = {
        hasCredential: async (id: string) =>
          (await ctx.internalAdapter.findCredentialAccount(id)) !== null,
      };
      const warn = vi.fn();
      const account = { userId, providerId: 'google' };
      const noState = async () => null;
      const linkState = async () => ({ link: { userId, email: 'x' } });
      const guard = (state: () => Promise<{ link?: unknown } | null>) =>
        createImplicitLinkGuard(credentials, { warn }, state);
      expect(
        await guard(noState)(account, { path: '/link-social' }),
      ).toBeUndefined();
      expect(
        await guard(linkState)(account, { path: '/callback/:id' }),
      ).toBeUndefined();
      expect(
        await guard(noState)({ userId, providerId: 'credential' }, null),
      ).toBeUndefined();
      expect(await guard(noState)(account, { path: '/callback/:id' })).toBe(
        false,
      );
      expect(await guard(noState)(account, { path: '/sign-in/social' })).toBe(
        false,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'identity_implicit_link_refused' }),
        expect.any(String),
      );
    });
  });

  it('S2-R6 / I3: the built-in 2FA account lockout is the only one and enforces AUTH_LOCKOUT_MAX_FAILURES, answering problem+json 429 + Retry-After', async () => {
    const withTwoFactor = async () => {
      const email = await verifiedUser();
      const c = cookieOf(
        await call('/sign-in/email', { body: { email, password: PASSWORD } }),
      );
      const en = await call('/two-factor/enable', {
        cookie: c,
        body: { password: PASSWORD },
      });
      const totp = URI.parse((await en.json()).totpURI);
      expect(
        (
          await call('/two-factor/verify-totp', {
            cookie: c,
            body: { code: totp.generate() },
          })
        ).status,
      ).toBe(200);
      return { email, totp };
    };
    /** Mã sai chắc chắn: khác mọi mã của cửa sổ trước/hiện tại/sau (otpauth chấp nhận lệch một chu kỳ). */
    const wrongCode = (totp: ReturnType<typeof URI.parse>) => {
      const period = 30_000;
      const valid = new Set(
        [-1, 0, 1].map((d) =>
          totp.generate({ timestamp: Date.now() + d * period }),
        ),
      );
      for (let n = 0; ; n++) {
        const code = String(n).padStart(6, '0');
        if (!valid.has(code)) return code;
      }
    };
    const challenge = async (email: string) => {
      const r = await call('/sign-in/email', {
        body: { email, password: PASSWORD },
      });
      const cookie = cookieOf(r);
      expect(await r.json()).toMatchObject({ twoFactorRedirect: true });
      return cookie;
    };

    // MAX-1 lần sai rồi mã đúng: qua (chưa khoá).
    const a = await withTwoFactor();
    const ca = await challenge(a.email);
    for (let i = 0; i < MAX_FAILURES - 1; i++)
      expect(
        (
          await call('/two-factor/verify-totp', {
            cookie: ca,
            body: { code: wrongCode(a.totp) },
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await call('/two-factor/verify-totp', {
          cookie: ca,
          body: { code: a.totp.generate() },
        })
      ).status,
    ).toBe(200);

    // MAX lần sai (mặc định của thư viện là 10): khoá, cả mã đúng cũng bị 429.
    const b = await withTwoFactor();
    const cb = await challenge(b.email);
    for (let i = 0; i < MAX_FAILURES; i++)
      await call('/two-factor/verify-totp', {
        cookie: cb,
        body: { code: wrongCode(b.totp) },
      });
    const locked = await call('/two-factor/verify-totp', {
      cookie: cb,
      body: { code: b.totp.generate() },
    });
    expect([locked.status, locked.headers.get('content-type')]).toEqual([
      429,
      expect.stringContaining('application/problem+json'),
    ]);
    expect(await locked.json()).toMatchObject({ code: 'rate_limited' });
    expect(locked.headers.get('retry-after')).toBe(
      String(identityGuardConfig().lockoutBlockSec),
    );
    // Không còn khoá 2FA tự viết: không có khoá nào có đoạn `2fa` (so theo đoạn: `LIKE '%2fa:%'` khớp nhầm hash hex
    // của khoá `signin` kết thúc bằng `2fa`, xác suất 1/4096 mỗi khoá, làm test chập chờn khi chạy cả suite).
    expect(
      (
        await owner.query(
          `SELECT 1 FROM auth.login_attempts WHERE key ~ '(^|:)2fa:'`,
        )
      ).rows,
    ).toEqual([]);
  });

  it('M1: a sensitive call reads the session once itself (bearer-aware) and never runs the nested /get-session pipeline (no JWT signed)', async () => {
    const email = await verifiedUser();
    const c = cookieOf(
      await call('/sign-in/email', { body: { email, password: PASSWORD } }),
    );
    const ctx = await auth.$context;
    const findSession = vi.spyOn(ctx.internalAdapter, 'findSession');
    const findMany = vi.spyOn(ctx.adapter, 'findMany');
    try {
      const r = await call('/change-password', {
        cookie: c,
        body: { currentPassword: PASSWORD, newPassword: 'fresh passphrase 1' },
      });
      expect(r.status).toBe(200);
      // Một lần của hook + một lần đọc "authoritative" của `sensitiveSessionMiddleware`.
      expect(findSession).toHaveBeenCalledTimes(2);
      expect(findMany.mock.calls.filter(([q]) => q.model === 'jwks')).toEqual(
        [],
      );
    } finally {
      findSession.mockRestore();
      findMany.mockRestore();
    }
  });

  it('M3: hooks set by buildAuthOptions still fire (user.create.after → onUserCreated)', async () => {
    const created: string[] = [];
    const inst = createAuthInstance({
      ...deps,
      onUserCreated: async (id) => void created.push(id),
    });
    const email = `m3-${v7()}@example.test`;
    const r = await inst.handler(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email, password: PASSWORD, name: 'M' }),
      }),
    );
    expect(r.status).toBe(202);
    expect(created).toEqual([await idOf(email)]);
  });

  it('M4: the expected parallel sign-up race is logged at info as signup_duplicate_race, never at ERROR', async () => {
    const eventOf = (e: unknown) =>
      typeof e === 'object' && e !== null && 'event' in e ? e.event : undefined;
    const infos = vi
      .spyOn(deps.logger, 'log')
      .mockImplementation(() => undefined);
    const warns = vi
      .spyOn(deps.logger, 'warn')
      .mockImplementation(() => undefined);
    const errors = vi
      .spyOn(deps.logger, 'error')
      .mockImplementation(() => undefined);
    try {
      const email = `race2-${v7()}@example.test`;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          call('/sign-up/email', {
            body: { email, password: PASSWORD, name: 'R' },
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
      const races = infos.mock.calls.filter(
        ([e]) => eventOf(e) === 'signup_duplicate_race',
      ).length;
      const libraryFailures = warns.mock.calls.filter(
        ([e]) => eventOf(e) === 'better_auth_create_user_failed',
      ).length;
      // Mỗi lần Better Auth log "Failed to create user" ứng với đúng một race đã xác nhận (user tồn tại).
      expect(races).toBe(libraryFailures);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      infos.mockRestore();
      warns.mockRestore();
      errors.mockRestore();
    }
  });

  it('M5: /request-password-reset normalizes the address before Better Auth looks it up', async () => {
    const email = await verifiedUser();
    const id = await idOf(email);
    expect(
      (
        await call('/request-password-reset', {
          body: { email: `  ${email.toUpperCase()} `, redirectTo: '/reset' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await owner.query(
          `SELECT 1 FROM auth.verification WHERE value = $1 AND identifier LIKE 'reset-password:%'`,
          [id],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('Task 32 carry-forward: onUserCreated is deferred to the reconcile cron (logged) when an app transaction is open', async () => {
    const created: string[] = [];
    const errors = vi
      .spyOn(deps.logger, 'error')
      .mockImplementation(() => undefined);
    const inTx = createAuthInstance({
      ...deps,
      inAppTransaction: () => true,
      onUserCreated: async (id) => void created.push(id),
    });
    try {
      const email = `tx-${v7()}@example.test`;
      const r = await inTx.handler(
        new Request(`${ORIGIN}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ email, password: PASSWORD, name: 'T' }),
        }),
      );
      expect(r.status).toBe(202);
      expect(created).toEqual([]);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'registered_event_deferred_open_transaction',
        }),
        expect.any(String),
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('maskEmails replaces every address in a Better Auth message', () => {
    expect(
      maskEmails(
        'Sign-up attempt for existing email: a.b+c@x.example.test and z@y.io',
      ),
    ).toBe('Sign-up attempt for existing email: [email] and [email]');
  });

  describe('S2-R37: OIDC provider registration is asserted at boot', () => {
    let idp: Server;
    let base: string;
    beforeAll(async () => {
      idp = createServer((req, res) => {
        const doc = {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(req.url?.startsWith('/good') ? { jwks_uri: `${base}/jwks` } : {}),
        };
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(doc));
      });
      await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        idp.close((e) => (e ? reject(e) : resolve())),
      );
    });
    const hybrid = (discovery: string) => {
      const identity = {
        ...identityConfig(),
        mode: 'hybrid' as const,
        oidcProviderId: 'corp',
        oidcDiscoveryUrl: `${base}${discovery}/.well-known/openid-configuration`,
        oidcClientId: 'client',
        oidcClientSecret: 'secret',
      };
      return { identity, auth: createAuthInstance({ ...deps, identity }) };
    };

    it('discovery without jwks_uri: Better Auth skips the provider, the boot check fails with a specific error', async () => {
      const { identity, auth: a } = hybrid('/bad');
      const errors = vi
        .spyOn(deps.logger, 'error')
        .mockImplementation(() => undefined);
      try {
        await expect(
          assertAuthProvidersRegistered(a, identity),
        ).rejects.toThrow(/OIDC provider "corp" did not register/);
      } finally {
        errors.mockRestore();
      }
    });
    it('discovery with issuer + jwks_uri: the provider is registered and the check passes', async () => {
      const { identity, auth: a } = hybrid('/good');
      await expect(
        assertAuthProvidersRegistered(a, identity),
      ).resolves.toBeUndefined();
    });
  });
});
