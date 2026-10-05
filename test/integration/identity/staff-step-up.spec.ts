import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import {
  LoginLockout,
  LockoutBlockedError,
  lockoutRowKeys,
} from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import {
  StaffStepUp,
  revokeUserCredentials,
  staffLacksFactorOf,
} from '../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

const RACE_ROUNDS = 50;
type Staff = { userId: string; sessionId: string; factorId: string | null };

describe('StaffStepUp against the real auth schema (spec SP3 §5.2, §9.7)', () => {
  let pool: pg.Pool;
  let s: StaffStepUp;
  const staff = async (
    o: {
      role?: string | null;
      factor?: 'verified' | 'pending' | 'none';
      flag?: boolean;
      banned?: boolean;
    } = {},
  ): Promise<Staff> => {
    const factor = o.factor ?? 'verified';
    const [u] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, role, two_factor_enabled, banned, created_at, updated_at, registered_event_emitted_at)
       VALUES ('Staff', $1, true, $2, $3, $4, now(), now(), now()) RETURNING id`,
      [
        `staff-${randomUUID()}@example.test`,
        o.role === undefined ? 'admin' : o.role,
        o.flag ?? factor === 'verified',
        o.banned ?? false,
      ],
    );
    const [sess] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
      [randomUUID(), u!.id],
    );
    const f =
      factor === 'none'
        ? []
        : await ownerQuery<{ id: string }>(
            `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('x', 'x', $1, $2) RETURNING id`,
            [u!.id, factor === 'verified'],
          );
    return { userId: u!.id, sessionId: sess!.id, factorId: f[0]?.id ?? null };
  };
  const mark = (x: Staff, method: 'totp' | 'backup_code', ageSec = 0) =>
    ownerQuery(
      `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, $3, now() - make_interval(secs => $4))`,
      [x.sessionId, x.factorId, method, ageSec],
    );
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    s = new StaffStepUp(pool);
  });
  afterAll(async () => pool?.end());

  it('TOTP mark: only a fresh totp mark on the current verified factor with the flag on counts', async () => {
    const a = await staff();
    expect(await s.totpMarkFresh(a.userId, a.sessionId, 600)).toBe(false);
    await mark(a, 'totp');
    expect(await s.totpMarkFresh(a.userId, a.sessionId, 600)).toBe(true);
    const b = await staff();
    await mark(b, 'backup_code');
    expect(await s.totpMarkFresh(b.userId, b.sessionId, 600)).toBe(false);
    const c = await staff();
    await mark(c, 'totp', 700);
    expect(await s.totpMarkFresh(c.userId, c.sessionId, 600)).toBe(false);
    const d = await staff();
    await mark(d, 'totp');
    await ownerQuery(
      `UPDATE auth."user" SET two_factor_enabled = false WHERE id = $1`,
      [d.userId],
    );
    expect(await s.totpMarkFresh(d.userId, d.sessionId, 600)).toBe(false);
  });
  it('R4A-N3: a session deleted after the read has no mark; there is no "0 rows = allow" branch', async () => {
    const a = await staff();
    await mark(a, 'totp');
    await ownerQuery(`DELETE FROM auth.session WHERE id = $1`, [a.sessionId]);
    expect(await s.totpMarkFresh(a.userId, a.sessionId, 600)).toBe(false);
    expect(await s.anyMarkVerifiedAt(a.sessionId, a.userId)).toBeUndefined();
  });
  it('anyMarkVerifiedAt accepts totp and backup_code marks, and only for the session owner', async () => {
    const a = await staff();
    await mark(a, 'backup_code');
    expect(await s.anyMarkVerifiedAt(a.sessionId, a.userId)).toBeInstanceOf(
      Date,
    );
    const other = await staff();
    expect(
      await s.anyMarkVerifiedAt(a.sessionId, other.userId),
    ).toBeUndefined();
  });
  it('factorState: staff without a factor (none, pending, flag off) lacks it; FOR SHARE waits for a transaction holding the user row', async () => {
    for (const o of [
      { factor: 'none' as const },
      { factor: 'pending' as const, flag: false },
      { factor: 'verified' as const, flag: false },
    ])
      expect(
        staffLacksFactorOf(await s.factorState((await staff(o)).userId)),
      ).toBe(true);
    expect(
      staffLacksFactorOf(await s.factorState((await staff()).userId)),
    ).toBe(false);
    expect(
      staffLacksFactorOf(
        await s.factorState(
          (await staff({ role: 'user', factor: 'none' })).userId,
        ),
      ),
    ).toBe(false);
    expect((await s.factorState(randomUUID())).exists).toBe(false);
    // Hướng của lệnh reset (spec §9.7 (5)): transaction giữ dòng user, xoá factor, ghi cờ `false`. Đọc phải CHỜ commit
    // rồi thấy "chưa có factor"; không có khoá thì nó trả trạng thái cũ (còn factor). Hướng ngược (thêm factor dưới khoá)
    // không phải hợp đồng của câu này: subquery đọc snapshot của câu lệnh nên kết quả là "chưa có factor" — fail closed.
    const a = await staff();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`,
        [a.userId],
      );
      await holder.query(`DELETE FROM auth.two_factor WHERE user_id = $1`, [
        a.userId,
      ]);
      await holder.query(
        `UPDATE auth."user" SET two_factor_enabled = false WHERE id = $1`,
        [a.userId],
      );
      let settled = false;
      const waiting = s.factorState(a.userId).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(settled).toBe(false);
      await holder.query('COMMIT');
      expect(staffLacksFactorOf(await waiting)).toBe(true);
    } finally {
      holder.release();
    }
  });
  it('otherAdminExists follows the plugin predicate: whitespace roles and banned admins do not count, an expired ban does', async () => {
    const me = await staff();
    await ownerQuery(
      `UPDATE auth."user" SET role = 'user' WHERE role LIKE '%admin%' AND id <> $1`,
      [me.userId],
    );
    expect(await s.otherAdminExists(me.userId)).toBe(false);
    await staff({ role: 'user, admin' });
    await staff({ role: 'admin', banned: true });
    expect(await s.otherAdminExists(me.userId)).toBe(false);
    const expired = await staff({ role: 'user,admin' });
    await ownerQuery(
      `UPDATE auth."user" SET banned = true, ban_expires = now() - interval '1 minute' WHERE id = $1`,
      [expired.userId],
    );
    expect(await s.otherAdminExists(me.userId)).toBe(true);
  });
  it('writeMark upserts one row; a replaced factor (captured id gone) is SKIPPED, not an error', async () => {
    const a = await staff();
    expect(
      await s.writeMark({
        sessionId: a.sessionId,
        factorId: a.factorId!,
        method: 'totp',
      }),
    ).toBe('MARKED');
    expect(
      await s.writeMark({
        sessionId: a.sessionId,
        factorId: a.factorId!,
        method: 'backup_code',
      }),
    ).toBe('MARKED');
    expect(
      await ownerQuery(
        `SELECT method FROM auth.session_second_factor WHERE session_id = $1`,
        [a.sessionId],
      ),
    ).toEqual([{ method: 'backup_code' }]);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE id = $1`, [a.factorId]);
    await ownerQuery(
      `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('z', 'z', $1, true)`,
      [a.userId],
    );
    expect(
      await s.writeMark({
        sessionId: a.sessionId,
        factorId: a.factorId!,
        method: 'totp',
      }),
    ).toBe('SKIPPED');
  });
  it(`S-19 (T-37): mark write ∥ factor delete ×${RACE_ROUNDS} → no mark survives the delete`, async () => {
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const a = await staff();
      const [w, d] = await Promise.allSettled([
        s.writeMark({
          sessionId: a.sessionId,
          factorId: a.factorId!,
          method: 'totp',
        }),
        pool.query(`DELETE FROM auth.two_factor WHERE id = $1`, [a.factorId]),
      ]);
      expect(d.status).toBe('fulfilled');
      if (w.status === 'rejected') throw w.reason;
      expect(
        await ownerQuery(
          `SELECT 1 FROM auth.session_second_factor WHERE session_id = $1`,
          [a.sessionId],
        ),
      ).toEqual([]);
    }
  });
  it('revokeUserCredentials removes factor, trust-device and reset tokens, IdP links, API keys (when asked) and sessions of that user only', async () => {
    const a = await staff();
    const b = await staff();
    for (const x of [a, b]) {
      await ownerQuery(
        `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('trust-device-' || $1, $1, now() + interval '1 day'), ('reset-password:' || $1, $1, now() + interval '1 day')`,
        [x.userId],
      );
      await ownerQuery(
        `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1::text, 'google', $1::uuid, now()), ($1::text, 'credential', $1::uuid, now())`,
        [x.userId],
      );
      await ownerQuery(
        `INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`,
        [x.userId, randomUUID()],
      );
    }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(
        await revokeUserCredentials(c, a.userId, { apiKeys: true }),
      ).toEqual({ apiKeysDeleted: 1 });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const left = async (x: Staff) => ({
      factor: (
        await ownerQuery(`SELECT 1 FROM auth.two_factor WHERE user_id = $1`, [
          x.userId,
        ])
      ).length,
      verification: (
        await ownerQuery(`SELECT 1 FROM auth.verification WHERE value = $1`, [
          x.userId,
        ])
      ).length,
      accounts: (
        await ownerQuery<{ provider_id: string }>(
          `SELECT provider_id FROM auth.account WHERE user_id = $1 ORDER BY 1`,
          [x.userId],
        )
      ).map((r) => r.provider_id),
      apiKeys: (
        await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [
          x.userId,
        ])
      ).length,
      sessions: (
        await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [
          x.userId,
        ])
      ).length,
    });
    expect(await left(a)).toEqual({
      factor: 0,
      verification: 0,
      accounts: ['credential'],
      apiKeys: 0,
      sessions: 0,
    });
    expect(await left(b)).toEqual({
      factor: 1,
      verification: 2,
      accounts: ['credential', 'google'],
      apiKeys: 1,
      sessions: 1,
    });
  });
  it('R7-C7: lockoutRowKeys covers every row the real guard() wrote for signin and step-up, and nothing of another user', async () => {
    const lockout = new LoginLockout(pool, {
      maxFailures: 2,
      windowSec: 60,
      blockSec: 60,
    });
    const email = `lk-${randomUUID()}@example.test`;
    const userId = randomUUID();
    for (const scope of [
      { kind: 'signin' as const, email },
      { kind: 'step-up' as const, userId },
    ]) {
      for (let i = 0; i < 3; i++)
        await lockout.guard(scope).catch((e: unknown) => {
          if (!(e instanceof LockoutBlockedError)) throw e;
        });
    }
    await lockout.guard({ kind: 'step-up', userId: randomUUID() });
    const keys = (
      await ownerQuery<{ key: string }>(`SELECT key FROM auth.login_attempts`)
    ).map((r) => r.key);
    const covered = (scope: Parameters<typeof lockoutRowKeys>[0]) => {
      const k = lockoutRowKeys(scope);
      return keys.filter(
        (key) =>
          k.exact.includes(key) || k.prefixes.some((p) => key.startsWith(p)),
      );
    };
    const mine = [
      ...covered({ kind: 'signin', email }),
      ...covered({ kind: 'step-up', userId }),
    ];
    expect(mine.some((k) => k.startsWith('blocks:'))).toBe(true);
    expect(mine.some((k) => k.startsWith('attempts:'))).toBe(true);
    expect(mine.some((k) => k.startsWith('tickets:'))).toBe(true);
    expect(mine.every((k) => k.includes(userId) || k.includes('signin:'))).toBe(
      true,
    );
    expect(keys.filter((k) => k.includes(`step-up:${userId}`)).sort()).toEqual(
      covered({ kind: 'step-up', userId }).sort(),
    );
  });
});
