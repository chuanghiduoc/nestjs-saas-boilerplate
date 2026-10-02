import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import {
  STAFF_PASSWORD,
  enrolStaff,
  marksOf,
  sessionTokenOf,
  stepUp,
} from '../../support/staff.js';

const otel = installOtelCapture();
const MAX = 4;
const EXTRA = 20;
const sessionIdOf = async (bearer: string) =>
  (
    await ownerQuery<{ id: string }>(
      `SELECT id FROM auth.session WHERE token = $1`,
      [sessionTokenOf(bearer)],
    )
  )[0]?.id;
const factorOf = async (userId: string) =>
  (
    await ownerQuery<{ id: string }>(
      `SELECT id FROM auth.two_factor WHERE user_id = $1`,
      [userId],
    )
  )[0]?.id;

describe('step-up 2FA in a session (spec SP3 §9.7 (1)(2), T7a–c, S-12 identity part, S-20)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentityApp({
      env: {
        AUTH_LOCKOUT_MAX_FAILURES: String(MAX),
        AUTH_TWO_FACTOR_RATE_MAX: '10000',
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('TOTP step-up over the cookie and over a bearer alone marks that session on the current factor; the session is unchanged', async () => {
    const s = await enrolStaff(app);
    expect(await marksOf(s.userId)).toEqual([]); // nhánh bật (verified=false) không ghi dấu
    const bearer = s.client.bearer ?? '';
    const before = await ownerQuery(
      `SELECT id, token FROM auth.session WHERE user_id = $1 ORDER BY id`,
      [s.userId],
    );
    const r1 = await stepUp(s);
    expect(r1.status).toBe(200);
    const r2 = await stepUp(s, { bearer });
    expect(r2.status).toBe(200);
    expect(
      await ownerQuery(
        `SELECT id, token FROM auth.session WHERE user_id = $1 ORDER BY id`,
        [s.userId],
      ),
    ).toEqual(before);
    const [m] = await marksOf(s.userId);
    expect(m).toMatchObject({
      session_id: await sessionIdOf(bearer),
      two_factor_id: await factorOf(s.userId),
      method: 'totp',
    });
    expect(
      Math.abs(Date.now() - new Date(m!.verified_at).getTime()),
    ).toBeLessThan(60_000);
    expect(
      await otel.metric('identity_second_factor_step_up_total', {
        result: 'marked',
        method: 'totp',
      }),
    ).toBeGreaterThanOrEqual(2);
  });
  it('a backup code marks method=backup_code', async () => {
    const s = await enrolStaff(app);
    expect((await stepUp(s, { backupCode: s.backupCodes[0] })).status).toBe(
      200,
    );
    expect((await marksOf(s.userId)).map((m) => m.method)).toEqual([
      'backup_code',
    ]);
  });
  it('no mark: sign-in with password + TOTP (no-session branch), a non-staff user, a wrong code, a malformed code (Review Focus 4)', async () => {
    const s = await enrolStaff(app);
    const fresh = new AuthClient(app.getHttpServer());
    expect(
      (await fresh.signIn(s.email, STAFF_PASSWORD)).body.twoFactorRedirect,
    ).toBe(true);
    expect(
      (
        await fresh.request('post', '/api/auth/two-factor/verify-totp', {
          body: { code: s.totp.generate() },
        })
      ).status,
    ).toBe(200);
    expect(await marksOf(s.userId)).toEqual([]);
    expect(
      (
        await s.client.request('post', '/api/auth/two-factor/verify-totp', {
          body: { code: '000000' },
        })
      ).status,
    ).toBe(401);
    const malformed = await s.client.request(
      'post',
      '/api/auth/two-factor/verify-totp',
      { body: { code: 'abc' } },
    );
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    expect(await marksOf(s.userId)).toEqual([]);
    const user = await enrolStaff(app, { role: 'user' });
    expect((await stepUp(user)).status).toBe(200);
    expect(await marksOf(user.userId)).toEqual([]);
  });
  it('a failing mark write keeps verify 200, leaves no mark and logs ERROR (fail closed)', async () => {
    const s = await enrolStaff(app);
    const errors = vi.spyOn(Logger.prototype, 'error');
    await ownerQuery(
      `REVOKE INSERT ON auth.session_second_factor FROM auth_user`,
    );
    try {
      expect((await stepUp(s)).status).toBe(200);
    } finally {
      await ownerQuery(
        `GRANT INSERT ON auth.session_second_factor TO auth_user`,
      );
    }
    expect(await marksOf(s.userId)).toEqual([]);
    expect(
      errors.mock.calls.some(
        ([o]) =>
          typeof o === 'object' &&
          o !== null &&
          'event' in o &&
          o.event === 'second_factor_mark_failed',
      ),
    ).toBe(true);
    errors.mockRestore();
  });
  it(`S-20 (T-38): ${MAX + EXTRA} parallel wrong codes → exactly ${MAX} reach the handler, the rest 429 + Retry-After; then even a right code is 429`, async () => {
    const s = await enrolStaff(app);
    const before =
      (await otel.metric('identity_second_factor_step_up_total', {
        result: 'invalid_code',
        method: 'totp',
      })) ?? 0;
    const rs = await Promise.all(
      Array.from({ length: MAX + EXTRA }, () =>
        s.client.request('post', '/api/auth/two-factor/verify-totp', {
          body: { code: '000000' },
        }),
      ),
    );
    expect(rs.filter((r) => r.status === 401)).toHaveLength(MAX);
    const limited = rs.filter((r) => r.status === 429);
    expect(limited).toHaveLength(EXTRA);
    expect(limited.every((r) => Number(r.headers['retry-after']) > 0)).toBe(
      true,
    );
    expect(
      (await otel.metric('identity_second_factor_step_up_total', {
        result: 'invalid_code',
        method: 'totp',
      })) ?? 0,
    ).toBe(before + MAX);
    expect((await stepUp(s)).status).toBe(429);
    expect(await marksOf(s.userId)).toEqual([]);
  });
  it('right codes are counted too (no refund): MAX correct step-ups, then 429', async () => {
    const s = await enrolStaff(app);
    for (let i = 0; i < MAX; i++) expect((await stepUp(s)).status).toBe(200);
    expect((await stepUp(s)).status).toBe(429);
  });
  it('a non-staff user in a session is not counted by the step-up lockout', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    const rs = await Promise.all(
      Array.from({ length: MAX + 2 }, () =>
        u.client.request('post', '/api/auth/two-factor/verify-totp', {
          body: { code: '000000' },
        }),
      ),
    );
    expect(rs.every((r) => r.status === 401)).toBe(true);
  });
});
