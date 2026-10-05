import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { URI, type TOTP } from 'otpauth';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { getInfra } from '../../support/infra.js';
import { STAFF_PASSWORD, enrolStaff } from '../../support/staff.js';

const hasEvent = (calls: unknown[][], key: string, value: string) =>
  calls.some(
    ([o]) =>
      typeof o === 'object' &&
      o !== null &&
      key in o &&
      (o as Record<string, unknown>)[key] === value,
  );

describe('post-write fence for staff without a factor (spec SP3 §9.7 (9), T-43, R8-S5) — requests with no reset in flight', () => {
  let app: INestApplication;
  const lacking = async () => {
    const client = new AuthClient(app.getHttpServer());
    const email = `fence-${randomUUID()}@example.test`;
    await client.signUp(email, STAFF_PASSWORD);
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
      [email],
    );
    expect((await client.signIn(email, STAFF_PASSWORD)).status).toBe(200);
    await ownerQuery(`UPDATE auth."user" SET role = 'admin' WHERE email = $1`, [
      email,
    ]);
    const [row] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = $1`,
      [email],
    );
    return { client, email, userId: row!.id };
  };
  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('(a) sign-in with the CURRENT password keeps the session (the operator-set password path)', async () => {
    const s = await lacking();
    const c = new AuthClient(app.getHttpServer());
    const r = await c.signIn(s.email, STAFF_PASSWORD);
    expect(r.status).toBe(200);
    expect(r.headers['set-auth-token']).toBeDefined();
  });
  it('(b) enable → verify-totp (enable branch) rotates from a live session of the same user → 200, not fenced', async () => {
    const s = await lacking();
    const en = await s.client.request('post', '/api/auth/two-factor/enable', {
      body: { password: STAFF_PASSWORD },
    });
    expect(en.status).toBe(200);
    const totp = URI.parse(String(en.body.totpURI)) as TOTP;
    const v = await s.client.request(
      'post',
      '/api/auth/two-factor/verify-totp',
      {
        body: { code: totp.generate() },
      },
    );
    expect(v.status).toBe(200);
    expect(
      await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [
        s.userId,
      ]),
    ).toHaveLength(1);
  });
  it('(iii) /api-key/create → 403 second_factor_required, the key row is deleted, no secret in the response', async () => {
    const s = await lacking();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const r = await s.client.request('post', '/api/auth/api-key/create', {
      body: { name: 'x' },
    });
    expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
    expect(r.body.key).toBeUndefined();
    expect(
      await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [
        s.userId,
      ]),
    ).toEqual([]);
    expect(hasEvent(warn.mock.calls, 'kind', 'api_key')).toBe(true);
    warn.mockRestore();
  });
  it('a regular user and staff WITH a factor keep SP2: sign-in and /api-key/create succeed', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    expect(
      (
        await u.client.request('post', '/api/auth/api-key/create', {
          body: { name: 'u' },
        })
      ).status,
    ).toBe(200);
    const s = await enrolStaff(app);
    expect(
      (
        await s.client.request('post', '/api/auth/api-key/create', {
          body: { name: 's' },
        })
      ).status,
    ).toBe(200);
  });
  it('the fence fails on the DB (the user row is held past the auth_user statement_timeout) → 503, ERROR staff_credential_fence_failed, no Set-Cookie', async () => {
    const s = await lacking();
    const errors = vi.spyOn(Logger.prototype, 'error');
    const { pg: p } = getInfra();
    const holder = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`,
        [s.userId],
      );
      const r = await new AuthClient(app.getHttpServer()).signIn(
        s.email,
        STAFF_PASSWORD,
      );
      expect(r.status).toBe(503);
      expect(r.headers['set-cookie']).toBeUndefined();
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(
      hasEvent(errors.mock.calls, 'event', 'staff_credential_fence_failed'),
    ).toBe(true);
    errors.mockRestore();
  }, 30_000);
});
