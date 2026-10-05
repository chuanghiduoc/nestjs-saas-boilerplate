import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { URI, type TOTP } from 'otpauth';
import type { Response } from 'supertest';
import { AuthClient } from './auth-client.js';
import { ownerQuery } from './identity-app.js';

export const STAFF_PASSWORD = 'staff correct horse battery';
export type EnrolledStaff = {
  client: AuthClient;
  email: string;
  userId: string;
  totp: TOTP;
  backupCodes: string[];
};

const must = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`enrolStaff: ${what}`);
};

/**
 * Nhân viên có factor THẬT qua endpoint của Better Auth (spec SP3 §18.0: ca S-* đi qua `verify-totp` thật). 2FA được bật
 * khi user còn là user thường (không tốn lượt lockout step-up, không đi qua hàng rào (9)); `role` đặt bằng SQL sau đó —
 * trạng thái mà production có sau `enable` + `verify-totp` của một nhân viên. Chưa có dấu step-up.
 *
 * Spike T7a: `verify-totp` của nhánh bật xoá session cũ và trả session mới CHỈ ở `Set-Cookie`/`set-auth-token` (token
 * trong body là của session cũ); `AuthClient.absorb` giữ cả hai, nên `client.bearer` là bearer của session mới.
 */
export async function enrolStaff(
  app: INestApplication,
  opts: { role?: string } = {},
): Promise<EnrolledStaff> {
  const client = new AuthClient(app.getHttpServer());
  const email = `staff-${randomUUID()}@example.test`;
  must((await client.signUp(email, STAFF_PASSWORD)).status === 202, 'sign-up');
  await ownerQuery(
    `UPDATE auth."user" SET email_verified = true WHERE email = $1`,
    [email],
  );
  must((await client.signIn(email, STAFF_PASSWORD)).status === 200, 'sign-in');
  const en = await client.request('post', '/api/auth/two-factor/enable', {
    body: { password: STAFF_PASSWORD },
  });
  must(en.status === 200, `enable ${en.status}`);
  const totp = URI.parse(String(en.body.totpURI)) as TOTP;
  const v = await client.request('post', '/api/auth/two-factor/verify-totp', {
    body: { code: totp.generate() },
  });
  must(v.status === 200, `verify-totp (enable) ${v.status}`);
  must(
    typeof v.headers['set-auth-token'] === 'string',
    'verify-totp (enable) returned no set-auth-token for the new session',
  );
  await ownerQuery(`UPDATE auth."user" SET role = $2 WHERE email = $1`, [
    email,
    opts.role ?? 'admin',
  ]);
  const [row] = await ownerQuery<{ id: string }>(
    `SELECT id FROM auth."user" WHERE email = $1`,
    [email],
  );
  if (!row) throw new Error('enrolStaff: user row missing');
  const backupCodes: unknown = en.body.backupCodes;
  return {
    client,
    email,
    userId: row.id,
    totp,
    backupCodes: Array.isArray(backupCodes) ? backupCodes.map(String) : [],
  };
}

/** Step-up trong session hiện có của client (cookie), hoặc chỉ bằng bearer. */
export function stepUp(
  s: EnrolledStaff,
  via: { bearer?: string; backupCode?: string } = {},
): Promise<Response> {
  const path = via.backupCode
    ? '/api/auth/two-factor/verify-backup-code'
    : '/api/auth/two-factor/verify-totp';
  const code = via.backupCode ?? s.totp.generate();
  return s.client.request('post', path, {
    body: { code },
    ...(via.bearer ? { cookie: false, bearer: via.bearer } : {}),
  });
}

/** Bearer của plugin `bearer` là dạng ký `<token>.<sig>`; `auth.session.token` lưu phần trước dấu chấm (spike T7a). */
export const sessionTokenOf = (bearer: string): string =>
  bearer.split('.')[0] ?? '';

export const marksOf = (userId: string) =>
  ownerQuery<{
    session_id: string;
    two_factor_id: string;
    method: string;
    verified_at: Date;
  }>(
    `SELECT m.session_id, m.two_factor_id, m.method, m.verified_at FROM auth.session_second_factor m
     JOIN auth.session s ON s.id = m.session_id WHERE s.user_id = $1 ORDER BY m.verified_at`,
    [userId],
  );
