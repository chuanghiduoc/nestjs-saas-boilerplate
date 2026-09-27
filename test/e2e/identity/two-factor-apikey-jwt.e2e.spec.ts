import type { INestApplication } from '@nestjs/common';
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from 'jose';
import { URI, type TOTP } from 'otpauth';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient, TEST_ORIGIN } from '../../support/auth-client.js';
import {
  ownerQuery,
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const PASSWORD = 'correct horse battery';
const ROTATION_SEC = 3600;
/** Thời hạn JWT = thời gian ân hạn của JWKS: đúng biên của bất biến Task 25 (`grace ≥ jwtExpiresIn`). */
const JWT_EXPIRES_IN_SEC = 900;
const JWKS_GRACE_SEC = JWT_EXPIRES_IN_SEC;
/** Hạn mặc định của API key (giây) cho test; plugin nhận GIÂY (review I3). */
const API_KEY_TTL_SEC = 86_400;
const EXPIRY_TOLERANCE_MS = 60_000;
/** Vượt mặc định 10 request/ngày của plugin (đã tắt ở Task 26). */
const API_KEY_CALLS = 15;
/** Khoảng đệm quanh `exp` khi giả lập thời gian trôi (giây); lớn hơn thời gian chạy giữa các bước. */
const EXP_MARGIN_SEC = 5;
const MS_PER_SEC = 1000;
/** `iss`/`aud` mặc định = origin của `AUTH_BASE_URL` (`effectiveJwtIssuer`/`effectiveJwtAudience`). */
const JWT_CLAIMS = { issuer: TEST_ORIGIN, audience: TEST_ORIGIN };

const isTotp = (v: unknown): v is TOTP =>
  typeof v === 'object' && v !== null && 'generate' in v && 'period' in v;
const parseTotp = (uri: unknown): TOTP => {
  const parsed = URI.parse(String(uri));
  if (!isTotp(parsed))
    throw new Error('two-factor/enable did not return a TOTP URI');
  return parsed;
};
const isJwks = (v: unknown): v is JSONWebKeySet =>
  typeof v === 'object' && v !== null && 'keys' in v && Array.isArray(v.keys);

describe('2FA, API keys and JWT/JWKS', () => {
  let app: INestApplication;
  const client = () => new AuthClient(app.getHttpServer());
  const signedIn = async () => {
    const email = `t-${v7()}@example.test`;
    const c = client();
    await c.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    return { email, c };
  };
  const jwks = async () => {
    const body: unknown = (
      await client().request('get', '/api/auth/jwks', { cookie: false })
    ).body;
    if (!isJwks(body)) throw new Error('/api/auth/jwks did not return a JWKS');
    return body;
  };
  beforeAll(async () => {
    app = await startIdentityApp({
      env: {
        AUTH_JWKS_ROTATION_INTERVAL_SEC: String(ROTATION_SEC),
        AUTH_JWT_EXPIRES_IN_SEC: String(JWT_EXPIRES_IN_SEC),
        AUTH_JWKS_GRACE_PERIOD_SEC: String(JWKS_GRACE_SEC),
        AUTH_API_KEY_DEFAULT_EXPIRES_IN_SEC: String(API_KEY_TTL_SEC),
        THROTTLE_DEFAULT_LIMIT: '1000',
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('TOTP: enable (fresh session) → pending sign-in cannot mint bearer/JWT/API key → TOTP → backup code → notice email', async () => {
    const { email, c } = await signedIn();
    const started = Date.now();
    const en = await c.request('post', '/api/auth/two-factor/enable', {
      body: { password: PASSWORD },
    });
    expect(en.status).toBe(200);
    const totp = parseTotp(en.body.totpURI);
    expect(
      (
        await c.request('post', '/api/auth/two-factor/verify-totp', {
          body: { code: totp.generate() },
        })
      ).status,
    ).toBe(200);
    await mailpitFromInfra().waitFor(email, {
      subject: /Two-factor authentication turned on/,
      after: started,
    });
    // Tiêu chí 11: mã dự phòng được mã hoá (không phải JSON mảng bản rõ).
    const stored = await ownerQuery<{ backup_codes: string }>(
      `SELECT backup_codes FROM auth.two_factor t JOIN auth."user" u ON u.id = t.user_id WHERE u.email = $1`,
      [email],
    );
    expect(stored).toHaveLength(1);
    expect(() => JSON.parse(stored[0]!.backup_codes)).toThrow();

    const p = client();
    const start = await p.signIn(email, PASSWORD);
    expect(start.status).toBe(200);
    expect(start.body.twoFactorRedirect).toBe(true);
    expect(start.headers['set-auth-token']).toBeUndefined();
    expect((await p.request('get', '/api/auth/get-session')).body).toBeNull();
    expect((await p.request('get', '/api/auth/token')).status).toBe(401);
    expect(
      (
        await p.request('post', '/api/auth/api-key/create', {
          body: { name: 'x' },
        })
      ).status,
    ).toBe(401);
    expect((await p.request('get', '/v1/me')).status).toBe(401);
    expect(
      (
        await p.request('post', '/api/auth/two-factor/verify-totp', {
          body: { code: totp.generate() },
        })
      ).status,
    ).toBe(200);
    expect((await p.request('get', '/v1/me')).status).toBe(200);

    const q = client();
    expect((await q.signIn(email, PASSWORD)).body.twoFactorRedirect).toBe(true);
    const backupCodes: unknown = en.body.backupCodes;
    expect(Array.isArray(backupCodes)).toBe(true);
    const [firstCode] = Array.isArray(backupCodes) ? backupCodes : [];
    expect(
      (
        await q.request('post', '/api/auth/two-factor/verify-backup-code', {
          body: { code: firstCode },
        })
      ).status,
    ).toBe(200);
    expect((await q.request('get', '/v1/me')).status).toBe(200);
  });

  it('sensitive operations with a stale session → 403 reauthentication_required', async () => {
    const { email, c } = await signedIn();
    await ownerQuery(
      `UPDATE auth.session SET created_at = now() - interval '1 day' WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email],
    );
    for (const [path, body] of [
      ['/api/auth/api-key/create', { name: 'x' }],
      ['/api/auth/two-factor/enable', { password: PASSWORD }],
    ] as const) {
      const r = await c.request('post', path, { body });
      expect([r.status, r.body.code]).toEqual([
        403,
        'reauthentication_required',
      ]);
    }
  });

  it('API key: works on Nest routes, never acts as a session on /api/auth/*, and dies with deletion', async () => {
    const { c } = await signedIn();
    const created = await c.request('post', '/api/auth/api-key/create', {
      body: { name: 'ci' },
    });
    expect(created.status).toBe(200);
    const key: string = created.body.key;
    expect(
      (await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(200);
    expect(
      (
        await c.request('get', '/api/auth/get-session', {
          cookie: false,
          apiKey: key,
        })
      ).body,
    ).toBeNull();
    expect(
      (
        await c.request('get', '/api/auth/token', {
          cookie: false,
          apiKey: key,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await c.request('post', '/api/auth/api-key/delete', {
          body: { keyId: created.body.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(401);
  });

  it('API key: default expiry is AUTH_API_KEY_DEFAULT_EXPIRES_IN_SEC seconds, and more than 10 calls a day are allowed', async () => {
    const { c } = await signedIn();
    const created = await c.request('post', '/api/auth/api-key/create', {
      body: { name: 'machine' },
    });
    expect(created.status).toBe(200);
    const expiresInMs = new Date(created.body.expiresAt).getTime() - Date.now();
    expect(Math.abs(expiresInMs - API_KEY_TTL_SEC * MS_PER_SEC)).toBeLessThan(
      EXPIRY_TOLERANCE_MS,
    );
    for (let i = 0; i < API_KEY_CALLS; i++)
      expect(
        (
          await c.request('get', '/v1/me', {
            cookie: false,
            apiKey: created.body.key,
          })
        ).status,
        `call ${i + 1}`,
      ).toBe(200);
  });

  it('S2-R46: a JWT comes only from /token; /get-session carries no set-auth-jwt header', async () => {
    const { c } = await signedIn();
    const s = await c.request('get', '/api/auth/get-session');
    expect(s.status).toBe(200);
    expect(s.body.user).toBeDefined();
    expect(s.headers['set-auth-jwt']).toBeUndefined();
    const t = await c.request('get', '/api/auth/token');
    expect(t.status).toBe(200);
    expect(t.headers['set-auth-jwt']).toBeUndefined();
    expect(typeof t.body.token).toBe('string');
  });

  it('JWT for other services: verified with jose against the public JWKS; after rotation the old key verifies until its last JWT expires, then leaves the JWKS', async () => {
    const { email, c } = await signedIn();
    const first: string = (await c.request('get', '/api/auth/token')).body
      .token;
    const { payload, protectedHeader } = await jwtVerify(
      first,
      createLocalJWKSet(await jwks()),
      JWT_CLAIMS,
    );
    const [user] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = $1`,
      [email],
    );
    expect(user).toBeDefined();
    expect(payload.sub).toBe(user?.id);
    expect(payload.exp! - payload.iat!).toBe(JWT_EXPIRES_IN_SEC);
    const oldKid = protectedHeader.kid;
    expect(oldKid).toBeTruthy();

    // Xoay: plugin coi khoá có `expires_at` đã qua là hết hạn ký (`jwt/sign.mjs`) và tự tạo khoá mới. `auth.jwks` dùng
    // chung giữa các file test (file chạy tuần tự): cho hết hạn MỌI khoá còn sống để lần ký sau chắc chắn dùng khoá mới.
    await ownerQuery(
      `UPDATE auth.jwks SET expires_at = now() - interval '1 second' WHERE expires_at IS NULL OR expires_at > now()`,
    );
    const second: string = (await c.request('get', '/api/auth/token')).body
      .token;
    const rotated = createLocalJWKSet(await jwks());
    const v2 = await jwtVerify(second, rotated, JWT_CLAIMS);
    expect(v2.protectedHeader.kid).not.toBe(oldKid);
    await expect(jwtVerify(first, rotated, JWT_CLAIMS)).resolves.toBeDefined();

    // Giả lập thời gian trôi bằng cách lùi mốc xoay của khoá cũ: còn EXP_MARGIN_SEC giây nữa JWT cũ hết hạn → khoá
    // cũ vẫn được công bố và JWT cũ verify được tại thời điểm đó.
    const exp = decodeJwt(first).exp!;
    const untilExpSec = exp - Math.floor(Date.now() / MS_PER_SEC);
    const shiftKey = (sec: number) =>
      ownerQuery(
        `UPDATE auth.jwks SET expires_at = expires_at - make_interval(secs => $2) WHERE id = $1`,
        [oldKid, sec],
      );
    await shiftKey(untilExpSec - EXP_MARGIN_SEC);
    const nearExpiry = await jwks();
    expect(nearExpiry.keys.map((k) => k.kid)).toContain(oldKid);
    await expect(
      jwtVerify(first, createLocalJWKSet(nearExpiry), {
        ...JWT_CLAIMS,
        currentDate: new Date((exp - EXP_MARGIN_SEC) * MS_PER_SEC),
      }),
    ).resolves.toBeDefined();
    // Qua `exp` của JWT cuối cùng mà khoá cũ có thể đã ký: khoá rời JWKS; JWT mới vẫn verify.
    await shiftKey(2 * EXP_MARGIN_SEC);
    const afterGrace = await jwks();
    expect(afterGrace.keys.map((k) => k.kid)).not.toContain(oldKid);
    await expect(
      jwtVerify(second, createLocalJWKSet(afterGrace), JWT_CLAIMS),
    ).resolves.toBeDefined();
    expect(decodeProtectedHeader(second).kid).toBe(v2.protectedHeader.kid);

    // Tiêu chí 11: private key trong `auth.jwks` được mã hoá (không có thành phần `d` của JWK bản rõ).
    const priv = await ownerQuery<{ private_key: string }>(
      `SELECT private_key FROM auth.jwks`,
    );
    expect(priv.length).toBeGreaterThan(0);
    for (const row of priv) expect(row.private_key).not.toMatch(/"d"\s*:/);
  });
});
