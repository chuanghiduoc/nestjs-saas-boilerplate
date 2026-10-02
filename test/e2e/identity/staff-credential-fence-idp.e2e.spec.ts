import type { INestApplication } from '@nestjs/common';
import type { Response } from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient, TEST_ORIGIN } from '../../support/auth-client.js';
import {
  FAKE_IDP_CLIENT_ID,
  FAKE_IDP_CLIENT_SECRET,
  startFakeIdp,
  type FakeIdp,
} from '../../support/fake-idp.js';
import {
  ownerQuery,
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';
import { seedStaffFactor } from '../../support/seed-staff-step-up.js';

/** Harness chép từ `oidc-linking.e2e.spec.ts` (plan 3D Task 9): IdP giả, callback thật. */
const PROVIDER = 'corp';
const PASSWORD = 'correct horse battery';
const CALLBACK_URL = '/';
const HTTP_FOUND = 302;

let idp: FakeIdp;
const oidcEnv = (trusted: string) => ({
  AUTH_MODE: 'hybrid',
  AUTH_OIDC_PROVIDER_ID: PROVIDER,
  AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
  AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
  AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
  AUTH_TRUSTED_PROVIDERS: trusted,
});
const location = (res: Response): URL => {
  expect(res.status).toBe(HTTP_FOUND);
  const loc: unknown = res.headers.location;
  if (typeof loc !== 'string') throw new Error('callback did not redirect');
  return new URL(loc, 'http://localhost:3000');
};
const errorOf = (res: Response): string | null =>
  location(res).searchParams.get('error');
const accountProviders = async (email: string): Promise<string[]> =>
  (
    await ownerQuery<{ provider_id: string }>(
      `SELECT a.provider_id FROM auth.account a JOIN auth."user" u ON u.id = a.user_id
        WHERE u.email = $1 ORDER BY a.provider_id`,
      [email],
    )
  ).map((r) => r.provider_id);
async function beginLogin(
  c: AuthClient,
  claims: Record<string, unknown>,
  startPath: string,
): Promise<string> {
  const start = await c.request('post', startPath, {
    body: { provider: PROVIDER, callbackURL: CALLBACK_URL },
  });
  expect(start.status).toBe(200);
  idp.setClaims(claims);
  const back = await idp.authorize(String(start.body.url));
  return `${back.pathname}${back.search}`;
}
const claimsFor = (email: string, extra: Record<string, unknown> = {}) => ({
  sub: `idp-${v7()}`,
  email,
  name: 'IdP User',
  ...extra,
});

describe('post-write fence (9)(ii): IdP links of staff without a factor (spec SP3 §9.7 (9), R8-S5)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    idp = await startFakeIdp({
      redirectUri: `${TEST_ORIGIN}/api/auth/callback/${PROVIDER}`,
    });
    // Provider TIN CẬY: với provider không tin cậy Better Auth tự từ chối mọi liên kết (`unable_to_link_account`),
    // ca "không factor" sẽ xanh mà không cần hàng rào (đường `/link-social` của `oidc-linking` cũng chạy dưới provider này).
    app = await startIdentityApp({ env: oidcEnv(PROVIDER) });
  });
  afterAll(async () => {
    await app?.close();
    await idp?.close();
    vi.unstubAllEnvs();
  });
  /** Admin có mật khẩu, đã xác thực email, đang đăng nhập; `withFactor` → factor đã verify (không cần dấu: không có gate). */
  const admin = async (withFactor: boolean) => {
    const email = `li-${v7()}@example.test`;
    const owner = new AuthClient(app.getHttpServer());
    await owner.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    expect((await owner.signIn(email, PASSWORD)).status).toBe(200);
    await ownerQuery(`UPDATE auth."user" SET role = 'admin' WHERE email = $1`, [
      email,
    ]);
    if (withFactor) {
      const [row] = await ownerQuery<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email = $1`,
        [email],
      );
      await seedStaffFactor(row!.id);
    }
    return { email, owner };
  };

  it('(ii) /link-social by staff without a factor: the new IdP link is removed', async () => {
    const { email, owner } = await admin(false);
    const linked = await owner.request(
      'get',
      await beginLogin(
        owner,
        claimsFor(email, { email_verified: true }),
        '/api/auth/link-social',
      ),
    );
    // Spec §9.7 (9)(ii): liên kết bị xoá và lỗi `account.create.after` đi ngược tới response của callback: 403 problem
    // (không phải redirect `?error=` của Better Auth — lỗi của hook không qua nhánh redirect lỗi OAuth).
    expect([linked.status, linked.body.code]).toEqual([
      403,
      'second_factor_required',
    ]);
    expect(await accountProviders(email)).toEqual(['credential']);
  });
  it('(ii) staff WITH a factor links normally (SP2)', async () => {
    const { email, owner } = await admin(true);
    const linked = await owner.request(
      'get',
      await beginLogin(
        owner,
        claimsFor(email, { email_verified: true }),
        '/api/auth/link-social',
      ),
    );
    expect(errorOf(linked)).toBeNull();
    expect(await accountProviders(email)).toEqual(['corp', 'credential']);
  });
});
