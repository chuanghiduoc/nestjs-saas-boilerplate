import { type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { AuthRequestState } from '../../../src/modules/identity/infra/better-auth/auth-request-state.js';
import {
  STAFF_RESET_EXIT_COMMITTED,
  STAFF_RESET_EXIT_OK,
  runStaffTwoFactorReset,
  type StaffResetSeams,
  type StaffResetTerminal,
} from '../../../src/modules/identity/infra/better-auth/staff-2fa-reset.js';
import {
  StaffStepUp,
  type Sql,
} from '../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { getInfra } from '../../support/infra.js';
import { STAFF_PASSWORD, enrolStaff, stepUp } from '../../support/staff.js';
import { startTcpProxy } from '../../support/tcp-proxy.js';

const RACE_ROUNDS = 50;
const POLL_MS = 20;
const DEADLINE_MS = 8_000;
const NEW_PASSWORD = 'attacker chosen passphrase 1';

/** Một cổng: test mở cổng, code tới cổng thì báo `arrived` rồi chờ `open()`. */
class Gate {
  private release: () => void = () => undefined;
  readonly opened = new Promise<void>((r) => (this.release = r));
  private arrive: () => void = () => undefined;
  readonly arrived = new Promise<void>((r) => (this.arrive = r));
  async pass(): Promise<void> {
    this.arrive();
    await this.opened;
  }
  open(): void {
    this.release();
  }
}
/**
 * Seam của test (spec §18.3 S-22 "seam giữ handler"): request state CỦA CHÍNH app (provider `AuthRequestState`) chờ ở đúng
 * điểm. `writeGate`: lớp chặn trước câu ghi đọc subject (TRƯỚC câu khoá đọc); `afterGuardGate`: lớp chặn đã ghi factor (SAU
 * kiểm, TRƯỚC câu UPDATE). Không cổng nào mở thì hành vi y như production.
 */
class GatedState extends AuthRequestState {
  writeGate: Gate | undefined;
  afterGuardGate: Gate | undefined;
  override async passwordWriteSubjects(): Promise<readonly string[] | null> {
    const g = this.writeGate;
    this.writeGate = undefined;
    if (g) await g.pass();
    return super.passwordWriteSubjects();
  }
  override async setWriteFactors(
    m: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    await super.setWriteFactors(m);
    const g = this.afterGuardGate;
    this.afterGuardGate = undefined;
    if (g) await g.pass();
  }
}

describe('reset command races (spec SP3 §9.7 (5), T-37/S-24, T-42, T-43)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  let pool: pg.Pool;
  const state = new GatedState();
  const deps = (seams?: StaffResetSeams, p: pg.Pool = pool) => ({
    auth,
    pool: p,
    seams,
    log: () => undefined,
  });
  const term = (
    answer: string,
    writeSecret: (s: string) => Promise<void> = async () => undefined,
  ): StaffResetTerminal => ({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    confirm: async () => answer,
    writeSecret,
    info: () => undefined,
  });
  /** Chờ tới khi một backend bị `pid` chặn (trực tiếp), không ngủ cố định. */
  const waitBlockedBy = async (pid: number) => {
    const until = Date.now() + DEADLINE_MS;
    for (;;) {
      const [r] = await ownerQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      );
      if ((r?.n ?? 0) > 0) return;
      if (Date.now() > until)
        throw new Error('nothing queued behind the reset transaction');
      await new Promise((ok) => setTimeout(ok, POLL_MS));
    }
  };
  const pidOf = async (c: Sql) =>
    (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
  const regularWithPassword = async () => {
    const c = new AuthClient(app.getHttpServer());
    const email = `race-${randomUUID()}@example.test`;
    await c.signUp(email, STAFF_PASSWORD);
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
      [email],
    );
    await c.signIn(email, STAFF_PASSWORD);
    const [row] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = $1`,
      [email],
    );
    return { client: c, email, userId: row!.id };
  };
  const resetToken = async (userId: string) => {
    const token = randomUUID().replaceAll('-', '');
    await ownerQuery(
      `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [`reset-password:${token}`, userId],
    );
    return token;
  };
  beforeAll(async () => {
    app = await startIdentityApp({
      configure: (b) => b.overrideProvider(AuthRequestState).useValue(state),
    });
    auth = app.get<AuthInstance>(BETTER_AUTH);
    pool = app.get<pg.Pool>(AUTH_POOL);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it.each(['/reset-password', '/change-password', '/admin/set-user-password'])(
    'R8-S1 %s: the before-hook passes while the user is regular, --for-promotion commits, then the write is refused at write time; the temporary password survives, no new session',
    async (path) => {
      const u = await regularWithPassword();
      // Chuẩn bị mọi thứ TRƯỚC khi đặt cổng: chỉ câu ghi mật khẩu của request đích được đi qua cổng.
      const admin =
        path === '/admin/set-user-password' ? await enrolStaff(app) : undefined;
      if (admin) expect((await stepUp(admin)).status).toBe(200);
      const token = await resetToken(u.userId);
      const gate = new Gate();
      state.writeGate = gate;
      const inFlight =
        path === '/reset-password'
          ? new AuthClient(app.getHttpServer()).request(
              'post',
              `/api/auth${path}`,
              { body: { token, newPassword: NEW_PASSWORD }, cookie: false },
            )
          : path === '/change-password'
            ? u.client.request('post', `/api/auth${path}`, {
                body: {
                  currentPassword: STAFF_PASSWORD,
                  newPassword: NEW_PASSWORD,
                },
              })
            : admin!.client.request('post', `/api/auth${path}`, {
                body: { userId: u.userId, newPassword: NEW_PASSWORD },
              });
      await gate.arrived;
      let secret = '';
      expect(
        await runStaffTwoFactorReset(
          {
            userId: u.userId,
            ticket: 'R8-S1',
            forPromotion: true,
            passwordFile: undefined,
          },
          term(u.email, async (s) => {
            secret = s;
          }),
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_OK);
      gate.open();
      const r = await inFlight;
      const expected = {
        '/reset-password': [400, 'invalid_or_expired_token'],
        '/change-password': [403, 'second_factor_required'],
        '/admin/set-user-password': [403, 'forbidden'],
      } as const;
      expect([r.status, r.body.code]).toEqual(
        expected[path as keyof typeof expected],
      );
      expect(
        (await new AuthClient(app.getHttpServer()).signIn(u.email, secret))
          .status,
      ).toBe(200);
      expect(
        (
          await new AuthClient(app.getHttpServer()).signIn(
            u.email,
            NEW_PASSWORD,
          )
        ).status,
      ).toBe(401);
    },
  );
  it('T-42 (9)(iv): the write slips past the pre-write guard and lands after the commit → the fence neutralizes every credential; the command then reports password_changed (exit 2); a rerun is exit 0', async () => {
    const u = await regularWithPassword();
    const gate = new Gate();
    state.afterGuardGate = gate;
    const token = await resetToken(u.userId);
    const inFlight = new AuthClient(app.getHttpServer()).request(
      'post',
      '/api/auth/reset-password',
      { body: { token, newPassword: NEW_PASSWORD }, cookie: false },
    );
    await gate.arrived;
    const seams: StaffResetSeams = {
      afterCommit: async () => {
        gate.open();
        await inFlight;
      },
    };
    expect(
      await runStaffTwoFactorReset(
        {
          userId: u.userId,
          ticket: 'T-42',
          forPromotion: true,
          passwordFile: undefined,
        },
        term(u.email),
        deps(seams),
      ),
    ).toBe(STAFF_RESET_EXIT_COMMITTED);
    const r = await inFlight;
    expect(r.status).toBe(400);
    expect(
      await ownerQuery(
        `SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`,
        [u.userId],
      ),
    ).toEqual([{ password: null }]);
    expect(
      await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [
        u.userId,
      ]),
    ).toEqual([]);
    let secret = '';
    expect(
      await runStaffTwoFactorReset(
        {
          userId: u.userId,
          ticket: 'T-42b',
          forPromotion: false,
          passwordFile: undefined,
        },
        term(u.email, async (s) => {
          secret = s;
        }),
        deps(),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    expect(
      (await new AuthClient(app.getHttpServer()).signIn(u.email, secret))
        .status,
    ).toBe(200);
  });
  it('T-43: a sign-in with the OLD password that read the hash before the commit is fenced after it (session deleted, 401 like a wrong password, no Set-Cookie)', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [
      s.userId,
    ]);
    await ownerQuery(
      `UPDATE auth."user" SET two_factor_enabled = false WHERE id = $1`,
      [s.userId],
    );
    let signIn: ReturnType<AuthClient['signIn']> | undefined;
    const seams: StaffResetSeams = {
      afterLockUser: async (c) => {
        signIn = new AuthClient(app.getHttpServer()).signIn(
          s.email,
          STAFF_PASSWORD,
        );
        await waitBlockedBy(await pidOf(c)); // hàng rào (FOR SHARE) xếp hàng sau khoá của lệnh
      },
    };
    expect(
      await runStaffTwoFactorReset(
        {
          userId: s.userId,
          ticket: 'T-43',
          forPromotion: false,
          passwordFile: undefined,
        },
        term(s.email),
        deps(seams),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    const r = await signIn!;
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(
      await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [
        s.userId,
      ]),
    ).toEqual([]);
  });
  it('T-43: /api-key/create by a session from before the command, held behind the transaction → the key is removed, 403, no secret', async () => {
    const s = await enrolStaff(app);
    let created: ReturnType<AuthClient['request']> | undefined;
    const seams: StaffResetSeams = {
      afterLockUser: async (c) => {
        created = s.client.request('post', '/api/auth/api-key/create', {
          body: { name: 'during reset' },
        });
        await waitBlockedBy(await pidOf(c));
      },
    };
    expect(
      await runStaffTwoFactorReset(
        {
          userId: s.userId,
          ticket: 'T-43b',
          forPromotion: false,
          passwordFile: undefined,
        },
        term(s.email),
        deps(seams),
      ),
    ).toBe(STAFF_RESET_EXIT_OK);
    const r = await created!;
    // Plugin đã đọc session (còn sống trước commit) và ghi key; hàng rào (9)(iii) chờ lệnh commit rồi thấy nhân viên chưa có
    // factor → xoá key, 403, không secret.
    expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
    expect(r.body.key).toBeUndefined();
    expect(
      await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [
        s.userId,
      ]),
    ).toEqual([]);
  });
  it(`S-24 (T-37): reset transaction ∥ step-up mark of the same staff ×${RACE_ROUNDS} → no mark after the commit; a deadlock only ever hits one side`, async () => {
    const marks = new StaffStepUp(pool);
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const s = await enrolStaff(app);
      const [f] = await ownerQuery<{ id: string }>(
        `SELECT id FROM auth.two_factor WHERE user_id = $1`,
        [s.userId],
      );
      const [sess] = await ownerQuery<{ id: string }>(
        `SELECT id FROM auth.session WHERE user_id = $1 LIMIT 1`,
        [s.userId],
      );
      const [reset, mark] = await Promise.allSettled([
        runStaffTwoFactorReset(
          {
            userId: s.userId,
            ticket: `S24-${i}`,
            forPromotion: false,
            passwordFile: undefined,
          },
          term(s.email),
          deps(),
        ),
        marks.writeMark({
          sessionId: sess!.id,
          factorId: f!.id,
          method: 'totp',
        }),
      ]);
      expect(reset).toEqual({
        status: 'fulfilled',
        value: STAFF_RESET_EXIT_OK,
      });
      expect(mark.status).toBe('fulfilled');
      expect(
        await ownerQuery(
          `SELECT 1 FROM auth.session_second_factor m JOIN auth.session x ON x.id = m.session_id WHERE x.user_id = $1`,
          [s.userId],
        ),
      ).toEqual([]);
    }
  }, 180_000);
  it('the connection drops while COMMIT is in flight → exit 2 (outcome unknown); the same command again → exit 0', async () => {
    const { pg: p } = getInfra();
    const proxy = await startTcpProxy(p.host, p.port);
    const flaky = createAuthPool(
      { ...authDatabaseConfig(), host: '127.0.0.1', port: proxy.port },
      databaseConfig(),
    );
    try {
      const s = await enrolStaff(app);
      // Ticket không chứa chữ "commit": proxy nhận diện COMMIT theo `\bcommit\b` trên cả gói Bind (tham số).
      proxy.state.commit = 'pooler-crash';
      const lines: string[] = [];
      const code = await runStaffTwoFactorReset(
        {
          userId: s.userId,
          ticket: 'CMT-1',
          forPromotion: false,
          passwordFile: undefined,
        },
        { ...term(s.email), info: (l) => lines.push(l) },
        deps(undefined, flaky),
      );
      expect([code, lines.at(-1)]).toEqual([
        STAFF_RESET_EXIT_COMMITTED,
        expect.stringContaining('COMMIT was in flight'),
      ]);
      proxy.state.commit = 'pass';
      expect(
        await runStaffTwoFactorReset(
          {
            userId: s.userId,
            ticket: 'CMT-2',
            forPromotion: false,
            passwordFile: undefined,
          },
          term(s.email),
          deps(),
        ),
      ).toBe(STAFF_RESET_EXIT_OK);
    } finally {
      await flaky.end();
      await proxy.close();
    }
  });
});
