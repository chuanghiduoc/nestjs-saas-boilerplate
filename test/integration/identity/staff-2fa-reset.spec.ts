import { Logger, type INestApplication } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { URI, type TOTP } from 'otpauth';
import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReconcileSecurityNoticesHandler } from '../../../src/modules/identity/application/reconcile-security-notices.handler.js';
import { SecurityNoticeService } from '../../../src/modules/identity/application/security-notice.service.js';
import { identityGuardConfig } from '../../../src/modules/identity/identity.config.js';
import { SecurityNoticeLedger } from '../../../src/modules/identity/ports/security-notice-ledger.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import {
  LOGIN_LOCKOUT,
  LockoutBlockedError,
  lockoutRowKeys,
  type LoginLockout,
} from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import {
  STAFF_RESET_EXIT_COMMITTED,
  STAFF_RESET_EXIT_NOT_COMMITTED,
  STAFF_RESET_EXIT_OK,
  runStaffTwoFactorReset,
  type StaffResetArgs,
  type StaffResetSeams,
  type StaffResetTerminal,
} from '../../../src/modules/identity/infra/better-auth/staff-2fa-reset.js';
import { AuthClient } from '../../support/auth-client.js';
import { getInfra } from '../../support/infra.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { Mailpit } from '../../support/mailpit.js';
import {
  STAFF_PASSWORD,
  enrolStaff,
  stepUp,
  type EnrolledStaff,
} from '../../support/staff.js';

const STALE = "interval '1 hour'";
type Logged = {
  level: string;
  entry: Record<string, unknown>;
  message: string;
};

describe('identity:staff-2fa-reset on the real database (spec SP3 §9.7 (5), S-22)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  let pool: pg.Pool;
  let lockout: LoginLockout;
  const logs: Logged[] = [];
  const deps = (seams?: StaffResetSeams) => ({
    auth,
    pool,
    seams,
    log: (
      level: 'warn' | 'error',
      entry: Record<string, unknown>,
      message: string,
    ) => logs.push({ level, entry, message }),
  });
  const terminal = (
    o: {
      answer?: string;
      stdinIsTTY?: boolean;
      stdoutIsTTY?: boolean;
      failWrite?: boolean;
    } = {},
  ) => {
    const secrets: string[] = [];
    const lines: string[] = [];
    const t: StaffResetTerminal = {
      stdinIsTTY: o.stdinIsTTY ?? true,
      stdoutIsTTY: o.stdoutIsTTY ?? true,
      confirm: async () => o.answer ?? '',
      writeSecret: async (s) => {
        if (o.failWrite) throw new Error('stdout closed');
        secrets.push(s);
      },
      info: (l) => lines.push(l),
    };
    return { t, secrets, lines };
  };
  const args = (
    userId: string,
    o: Partial<StaffResetArgs> = {},
  ): StaffResetArgs => ({
    userId,
    ticket: 'SUP-1',
    forPromotion: false,
    passwordFile: undefined,
    ...o,
  });
  /** Ảnh chụp mọi dòng auth của user (exit 1 = DB không đổi). */
  const snapshot = async (id: string) => ({
    user: await ownerQuery(
      `SELECT role, two_factor_enabled FROM auth."user" WHERE id = $1`,
      [id],
    ),
    accounts: await ownerQuery<{
      provider_id: string;
      password: string | null;
    }>(
      `SELECT provider_id, password FROM auth.account WHERE user_id = $1 ORDER BY provider_id`,
      [id],
    ),
    factors: await ownerQuery(
      `SELECT id FROM auth.two_factor WHERE user_id = $1`,
      [id],
    ),
    sessions: await ownerQuery(
      `SELECT id FROM auth.session WHERE user_id = $1 ORDER BY id`,
      [id],
    ),
    keys: await ownerQuery(
      `SELECT id FROM auth.apikey WHERE reference_id = $1 ORDER BY id`,
      [id],
    ),
    verification: await ownerQuery(
      `SELECT identifier FROM auth.verification WHERE value = $1 ORDER BY identifier`,
      [id],
    ),
    notices: await ownerQuery<{ kind: string; ticket: string | null }>(
      `SELECT kind, ticket FROM auth.security_notice WHERE user_id = $1 ORDER BY created_at, id`,
      [id],
    ),
  });
  /** Nhân viên đầy đủ: factor thật, hai session, thiết bị tin cậy, token đặt lại còn hạn, liên kết IdP, API key, lockout. */
  const richStaff = async (): Promise<
    EnrolledStaff & { otherUserKey: string }
  > => {
    const s = await enrolStaff(app);
    await ownerQuery(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now())`,
      [randomUUID(), s.userId],
    );
    await ownerQuery(
      `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('trust-device-' || $1, $1, now() + interval '1 day'), ('reset-password:' || $2, $1, now() + interval '1 hour')`,
      [s.userId, randomUUID()],
    );
    await ownerQuery(
      `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1::text, 'google', $1::uuid, now())`,
      [s.userId],
    );
    await ownerQuery(
      `INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now()), ('default', $1, $3, now(), now())`,
      [s.userId, randomUUID(), randomUUID()],
    );
    for (const scope of [
      { kind: 'signin' as const, email: s.email },
      { kind: 'step-up' as const, userId: s.userId },
    ])
      for (let i = 0; i < 12; i++)
        await lockout.guard(scope).catch((e: unknown) => {
          if (!(e instanceof LockoutBlockedError)) throw e;
        });
    const other = `other-${randomUUID()}@example.test`;
    await lockout.guard({ kind: 'signin', email: other });
    return { ...s, otherUserKey: other };
  };
  const enrolAfterReset = async (email: string, temp: string) => {
    const c = new AuthClient(app.getHttpServer());
    expect((await c.signIn(email, temp)).status).toBe(200);
    const en = await c.request('post', '/api/auth/two-factor/enable', {
      body: { password: temp },
    });
    expect(en.status).toBe(200);
    const totp = URI.parse(String(en.body.totpURI)) as TOTP;
    expect(
      (
        await c.request('post', '/api/auth/two-factor/verify-totp', {
          body: { code: totp.generate() },
        })
      ).status,
    ).toBe(200);
    return { c, totp };
  };
  beforeAll(async () => {
    app = await startIdentityApp();
    auth = app.get<AuthInstance>(BETTER_AUTH);
    pool = app.get<pg.Pool>(AUTH_POOL);
    lockout = app.get<LoginLockout>(LOGIN_LOCKOUT);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('RESET of staff with everything: exit 0, one secret, every credential removed, one operator_reset marker with the ticket; mails go out; the temp password signs in; enable → step-up → /admin/* and /change-password work', async () => {
    const s = await richStaff();
    const mail = new Mailpit(getInfra().mailpit.apiUrl);
    const since = await mail.now();
    const { t, secrets, lines } = terminal({ answer: s.email });
    expect(
      await runStaffTwoFactorReset(
        args(s.userId, { ticket: 'SUP-22' }),
        t,
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    expect(secrets).toHaveLength(1);
    const temp = secrets[0]!;
    expect(lines.join('\n')).not.toContain(temp);
    expect(JSON.stringify(logs)).not.toContain(temp);
    expect(logs.at(-1)).toMatchObject({
      level: 'warn',
      entry: {
        event: 'identity_staff_2fa_reset',
        userId: s.userId,
        ticket: 'SUP-22',
        mode: 'RESET',
        apiKeysDeleted: 2,
      },
    });
    const after = await snapshot(s.userId);
    expect(after.user).toEqual([{ role: 'admin', two_factor_enabled: false }]);
    expect(after.accounts.map((a) => a.provider_id)).toEqual(['credential']);
    expect([
      after.factors,
      after.sessions,
      after.keys,
      after.verification,
    ]).toEqual([[], [], [], []]);
    expect(after.notices.filter((n) => n.kind === 'operator_reset')).toEqual([
      { kind: 'operator_reset', ticket: 'SUP-22' },
    ]);
    const lockKeys = (
      await ownerQuery<{ key: string }>(`SELECT key FROM auth.login_attempts`)
    ).map((r) => r.key);
    const covered = (scope: Parameters<typeof lockoutRowKeys>[0]) => {
      const k = lockoutRowKeys(scope);
      return lockKeys.filter(
        (x) => k.exact.includes(x) || k.prefixes.some((p) => x.startsWith(p)),
      );
    };
    expect([
      ...covered({ kind: 'signin', email: s.email }),
      ...covered({ kind: 'step-up', userId: s.userId }),
    ]).toEqual([]);
    expect(covered({ kind: 'signin', email: s.otherUserKey })).not.toEqual([]); // bộ đếm của user khác còn nguyên
    await ownerQuery(
      `UPDATE auth.security_notice SET created_at = created_at - ${STALE} WHERE user_id = $1`,
      [s.userId],
    );
    // Handler của cron chỉ có ở worker; dựng từ provider của app api như `auth-hooks.spec.ts`.
    await new ReconcileSecurityNoticesHandler(
      identityGuardConfig(),
      app.get(SecurityNoticeLedger),
      app.get(SecurityNoticeService),
    ).handle({
      payload: {},
      meta: {},
      jobId: v7(),
      attempt: 1,
      maxAttempts: 1,
      signal: new AbortController().signal,
      log: new Logger('t'),
    });
    await mail.waitFor(s.email, {
      subject: /Your password and two-factor authentication were reset/,
      after: since,
    });
    await mail.waitFor(s.email, {
      subject: /Two-factor authentication turned off/,
      after: since,
    });
    expect(
      (
        await new AuthClient(app.getHttpServer()).signIn(
          s.email,
          STAFF_PASSWORD,
        )
      ).status,
    ).toBe(401);
    const { c, totp } = await enrolAfterReset(s.email, temp);
    expect((await stepUp({ ...s, client: c, totp })).status).toBe(200);
    expect((await c.request('get', '/api/auth/admin/list-users')).status).toBe(
      200,
    );
    expect(
      (
        await c.request('post', '/api/auth/change-password', {
          body: {
            currentPassword: temp,
            newPassword: 'a new staff passphrase 22',
          },
        })
      ).status,
    ).toBe(200);
  });
  it('N6-1: right after the command, every HTTP password path refuses (reset 400, change 403 second_factor_required, admin set 403 forbidden) and the temporary password still signs in', async () => {
    const s = await enrolStaff(app);
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(
      STAFF_RESET_EXIT_OK,
    );
    const temp = secrets[0]!;
    const token = randomUUID().replaceAll('-', '');
    await ownerQuery(
      `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [`reset-password:${token}`, s.userId],
    );
    const anon = new AuthClient(app.getHttpServer());
    expect(
      (
        await anon.request('post', '/api/auth/reset-password', {
          body: { token, newPassword: 'attacker passphrase 1' },
          cookie: false,
        })
      ).status,
    ).toBe(400);
    const c = new AuthClient(app.getHttpServer());
    expect((await c.signIn(s.email, temp)).status).toBe(200);
    expect(
      (
        await c.request('post', '/api/auth/change-password', {
          body: { currentPassword: temp, newPassword: 'x'.repeat(20) },
        })
      ).body.code,
    ).toBe('second_factor_required');
    const admin = await enrolStaff(app);
    await stepUp(admin);
    expect(
      (
        await admin.client.request(
          'post',
          '/api/auth/admin/set-user-password',
          {
            body: { userId: s.userId, newPassword: 'y'.repeat(20) },
          },
        )
      ).body.code,
    ).toBe('forbidden');
    expect(
      (await new AuthClient(app.getHttpServer()).signIn(s.email, temp)).status,
    ).toBe(200);
  });
  it('last admin, no factor, no session: the command still restores access (N5-4)', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(`DELETE FROM auth.session WHERE user_id = $1`, [s.userId]);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [
      s.userId,
    ]);
    await ownerQuery(
      `UPDATE auth."user" SET role = 'user' WHERE id <> $1 AND role IS NOT NULL AND role <> 'user'`,
      [s.userId],
    );
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(
      STAFF_RESET_EXIT_OK,
    );
    const { c, totp } = await enrolAfterReset(s.email, secrets[0]!);
    expect((await stepUp({ ...s, client: c, totp })).status).toBe(200);
    expect((await c.request('get', '/api/auth/admin/list-users')).status).toBe(
      200,
    );
  });
  it('PROMOTE (N6-5): a regular user with 2FA, sessions and an IdP link → role admin, everything removed in ONE transaction (a concurrent reader never sees admin with the old factor); API keys kept', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    await ownerQuery(
      `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1::text, 'google', $1::uuid, now())`,
      [u.userId],
    );
    await ownerQuery(
      `INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`,
      [u.userId, randomUUID()],
    );
    const seen: { role: string | null; factors: number }[] = [];
    const seams: StaffResetSeams = {
      afterUpsert: async () => {
        // Kết nối khác đọc trong lúc transaction mở: vẫn là bản trước lệnh (role thường, factor cũ).
        seen.push(
          ...(await ownerQuery<{ role: string | null; factors: number }>(
            `SELECT u.role, (SELECT count(*)::int FROM auth.two_factor f WHERE f.user_id = u.id) AS factors FROM auth."user" u WHERE u.id = $1`,
            [u.userId],
          )),
        );
      },
    };
    const { t } = terminal({ answer: u.email });
    expect(
      await runStaffTwoFactorReset(
        args(u.userId, { forPromotion: true }),
        t,
        deps(seams),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    expect(seen).toEqual([{ role: 'user', factors: 1 }]);
    const after = await snapshot(u.userId);
    expect(after.user).toEqual([{ role: 'admin', two_factor_enabled: false }]);
    expect([
      after.factors,
      after.sessions,
      after.accounts.map((a) => a.provider_id),
      after.keys.length,
    ]).toEqual([[], [], ['credential'], 1]);
    expect(logs.at(-1)?.entry).toMatchObject({
      mode: 'PROMOTE',
      apiKeysDeleted: 0,
    });
  });
  it('an IdP-only staff member (no credential account) gets a credential account', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(
      `DELETE FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`,
      [s.userId],
    );
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(
      STAFF_RESET_EXIT_OK,
    );
    expect(
      (await new AuthClient(app.getHttpServer()).signIn(s.email, secrets[0]!))
        .status,
    ).toBe(200);
  });
  it('arguments and terminal (N6-3, N6-4): each refusal is exit 1 with the DB unchanged and no file left', async () => {
    const s = await richStaff();
    const u = await enrolStaff(app, { role: 'user' });
    const before = await snapshot(s.userId);
    const dir = await mkdtemp(join(tmpdir(), 'staff-reset-'));
    try {
      expect(
        await runStaffTwoFactorReset(
          args(u.userId),
          terminal({ answer: u.email }).t,
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(
        await runStaffTwoFactorReset(
          args(s.userId),
          terminal({ answer: 'someone@else.test' }).t,
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(
        await runStaffTwoFactorReset(
          args(s.userId),
          terminal({ answer: s.email, stdinIsTTY: false }).t,
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(
        await runStaffTwoFactorReset(
          args(s.userId),
          terminal({ answer: s.email, stdoutIsTTY: false }).t,
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(
        await runStaffTwoFactorReset(args(randomUUID()), terminal().t, deps()),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      const existing = join(dir, 'exists');
      await writeFile(existing, 'keep');
      expect(
        await runStaffTwoFactorReset(
          args(s.userId, { passwordFile: existing }),
          terminal({ answer: s.email, stdoutIsTTY: false }).t,
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await readFile(existing, 'utf8')).toBe('keep');
      expect(await snapshot(s.userId)).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('--password-file without a TTY on stdout: exit 0, file mode 0600 holds the password, nothing on stdout', async () => {
    const s = await enrolStaff(app);
    const dir = await mkdtemp(join(tmpdir(), 'staff-reset-'));
    try {
      const file = join(dir, 'pw');
      const { t, secrets } = terminal({ answer: s.email, stdoutIsTTY: false });
      expect(
        await runStaffTwoFactorReset(
          args(s.userId, { passwordFile: file }),
          t,
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_OK);
      expect(secrets).toEqual([]);
      const temp = (await readFile(file, 'utf8')).trim();
      if (process.platform !== 'win32')
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(
        (await new AuthClient(app.getHttpServer()).signIn(s.email, temp))
          .status,
      ).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('R8-S6: exit 1 means the DB did not change — a failure right after the password upsert, and three deadlocks in a row', async () => {
    const s = await richStaff();
    const before = await snapshot(s.userId);
    const dir = await mkdtemp(join(tmpdir(), 'staff-reset-'));
    try {
      const file = join(dir, 'pw');
      const boom: StaffResetSeams = {
        afterUpsert: async () => {
          throw new Error('seam');
        },
      };
      expect(
        await runStaffTwoFactorReset(
          args(s.userId, { passwordFile: file }),
          terminal({ answer: s.email }).t,
          deps(boom),
        ),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      const deadlock: StaffResetSeams = {
        afterUpsert: async () => {
          throw Object.assign(new Error('deadlock detected'), {
            code: '40P01',
          });
        },
      };
      expect(
        await runStaffTwoFactorReset(
          args(s.userId),
          terminal({ answer: s.email }).t,
          deps(deadlock),
        ),
      ).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await snapshot(s.userId)).toEqual(before);
      // `richStaff` đã rút cạn lockout đăng nhập của user; exit 1 nghĩa là cả câu xoá bộ đếm cũng đã ROLLBACK, nên đăng
      // nhập vẫn bị khoá (mật khẩu cũ giữ nguyên đã được `snapshot` so ở trên).
      expect(
        (
          await new AuthClient(app.getHttpServer()).signIn(
            s.email,
            STAFF_PASSWORD,
          )
        ).status,
      ).toBe(429);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('the user changes between the confirmation and the transaction (role, email) → exit 1, DB unchanged', async () => {
    const s = await enrolStaff(app);
    const before = await snapshot(s.userId);
    const t = terminal({ answer: s.email }).t;
    const changing: StaffResetTerminal = {
      ...t,
      confirm: async () => {
        await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id = $1`, [
          s.userId,
        ]);
        return s.email;
      },
    };
    expect(await runStaffTwoFactorReset(args(s.userId), changing, deps())).toBe(
      STAFF_RESET_EXIT_NOT_COMMITTED,
    );
    expect((await snapshot(s.userId)).factors).toEqual(before.factors);
    expect((await snapshot(s.userId)).notices).toEqual(before.notices);
  });
  it('review I-1: the post-commit step throws after a successful COMMIT → exit 2 (not 1), no secret, the --password-file is removed, a raced log without secrets; the rerun is exit 0', async () => {
    const s = await enrolStaff(app);
    const dir = await mkdtemp(join(tmpdir(), 'staff-reset-'));
    try {
      const file = join(dir, 'pw');
      const boom: StaffResetSeams = {
        afterCommit: async () => {
          throw new Error('post-commit read failed');
        },
      };
      const a = terminal({ answer: s.email, stdoutIsTTY: false });
      expect(
        await runStaffTwoFactorReset(
          args(s.userId, { passwordFile: file }),
          a.t,
          deps(boom),
        ),
      ).toBe(STAFF_RESET_EXIT_COMMITTED);
      expect(a.secrets).toEqual([]);
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(logs.at(-1)).toMatchObject({
        level: 'warn',
        entry: {
          event: 'identity_staff_2fa_reset_raced',
          reason: 'post_commit_check_failed',
          userId: s.userId,
        },
      });
      // Đã commit thật: marker của lệnh có trong DB.
      expect(
        (await snapshot(s.userId)).notices.filter(
          (n) => n.kind === 'operator_reset',
        ),
      ).toHaveLength(1);
      const again = terminal({ answer: s.email, stdoutIsTTY: false });
      expect(
        await runStaffTwoFactorReset(
          args(s.userId, { passwordFile: file }),
          again.t,
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_OK);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('N7-4: the hash or the factor changes after the commit → exit 2 with the reason, no secret delivered, file removed; the same command again → exit 0', async () => {
    const s = await enrolStaff(app);
    const hashChange: StaffResetSeams = {
      afterCommit: async () => {
        await ownerQuery(
          `UPDATE auth.account SET password = 'raced' WHERE user_id = $1 AND provider_id = 'credential'`,
          [s.userId],
        );
      },
    };
    const a = terminal({ answer: s.email });
    expect(
      await runStaffTwoFactorReset(args(s.userId), a.t, deps(hashChange)),
    ).toBe(STAFF_RESET_EXIT_COMMITTED);
    expect(a.secrets).toEqual([]);
    expect(logs.at(-1)).toMatchObject({
      entry: {
        event: 'identity_staff_2fa_reset_raced',
        reason: 'password_changed',
        ticket: 'SUP-1',
      },
    });
    const factorOn: StaffResetSeams = {
      afterCommit: async () => {
        await ownerQuery(
          `UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`,
          [s.userId],
        );
      },
    };
    expect(
      await runStaffTwoFactorReset(
        args(s.userId),
        terminal({ answer: s.email }).t,
        deps(factorOn),
      ),
    ).toBe(STAFF_RESET_EXIT_COMMITTED);
    expect(logs.at(-1)?.entry).toMatchObject({ reason: 'factor_present' });
    const again = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), again.t, deps())).toBe(
      STAFF_RESET_EXIT_OK,
    );
    expect(
      (
        await new AuthClient(app.getHttpServer()).signIn(
          s.email,
          again.secrets[0]!,
        )
      ).status,
    ).toBe(200);
  });
  it('R7-C5/R8-C1: delivery fails after a --for-promotion commit → exit 2; the same command (still --for-promotion) runs as RESET: exit 0, two markers, API keys deleted', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    await ownerQuery(
      `INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`,
      [u.userId, randomUUID()],
    );
    expect(
      await runStaffTwoFactorReset(
        args(u.userId, { forPromotion: true }),
        terminal({ answer: u.email, failWrite: true }).t,
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_COMMITTED);
    expect(
      await runStaffTwoFactorReset(
        args(u.userId, { forPromotion: true }),
        terminal({ answer: u.email }).t,
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    const after = await snapshot(u.userId);
    expect([
      after.user[0],
      after.keys,
      after.notices.filter((n) => n.kind === 'operator_reset').length,
    ]).toEqual([{ role: 'admin', two_factor_enabled: false }, [], 2]);
  });
  it('R8-C1: after an attacker won T-42 (other password, a verified factor, an API key, a session), the same command runs as RESET and removes all of it', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    expect(
      await runStaffTwoFactorReset(
        args(u.userId, { forPromotion: true }),
        terminal({ answer: u.email }).t,
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    await ownerQuery(
      `UPDATE auth.account SET password = 'attacker' WHERE user_id = $1 AND provider_id = 'credential'`,
      [u.userId],
    );
    await ownerQuery(
      `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('a', 'a', $1, true)`,
      [u.userId],
    );
    await ownerQuery(
      `UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`,
      [u.userId],
    );
    await ownerQuery(
      `INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`,
      [u.userId, randomUUID()],
    );
    await ownerQuery(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now())`,
      [randomUUID(), u.userId],
    );
    const again = terminal({ answer: u.email });
    expect(
      await runStaffTwoFactorReset(
        args(u.userId, { forPromotion: true }),
        again.t,
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    const after = await snapshot(u.userId);
    expect([after.factors, after.keys, after.sessions]).toEqual([[], [], []]);
    expect(
      (
        await new AuthClient(app.getHttpServer()).signIn(
          u.email,
          again.secrets[0]!,
        )
      ).status,
    ).toBe(200);
  });
  it('twice in a row: the second run is exit 0 too, same end state plus one marker', async () => {
    const s = await enrolStaff(app);
    expect(
      await runStaffTwoFactorReset(
        args(s.userId),
        terminal({ answer: s.email }).t,
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    expect(
      await runStaffTwoFactorReset(
        args(s.userId),
        terminal({ answer: s.email }).t,
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    expect(
      (await snapshot(s.userId)).notices.filter(
        (n) => n.kind === 'operator_reset',
      ),
    ).toHaveLength(2);
  });
  it('N6-2: an IdP session that drained the step-up lockout cannot block the factor enrolment after the command', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(
      `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1::text, 'google', $1::uuid, now())`,
      [s.userId],
    );
    for (let i = 0; i < 12; i++)
      await s.client.request('post', '/api/auth/two-factor/verify-totp', {
        body: { code: '000000' },
      });
    expect((await stepUp(s)).status).toBe(429);
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(
      STAFF_RESET_EXIT_OK,
    );
    expect(
      await ownerQuery(
        `SELECT 1 FROM auth.account WHERE user_id = $1 AND provider_id = 'google'`,
        [s.userId],
      ),
    ).toEqual([]);
    await enrolAfterReset(s.email, secrets[0]!);
  });
  it('R7-C8: the real CLI entry without a TTY exits 1 before touching the database and leaves the process on its own (no hang)', () => {
    const r = spawnSync(
      process.execPath,
      [
        'dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js',
        '--user-id',
        randomUUID(),
        '--ticket',
        'T',
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 },
    );
    expect([r.status, r.stderr]).toEqual([
      1,
      expect.stringContaining('needs an interactive terminal'),
    ]);
  });
});
