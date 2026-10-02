import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../../src/core/config/index.js';
import { httpConfig } from '../../../../src/core/http/index.js';
import { IdentityErrors } from '../../../../src/modules/identity/errors.js';
import { IdentityMetrics } from '../../../../src/modules/identity/identity-metrics.js';
import {
  identityConfig,
  identityGuardConfig,
} from '../../../../src/modules/identity/identity.config.js';
import { StaffStepUp } from '../../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { PlatformAdminAuthorizer } from '../../../../src/modules/identity/infra/dashboard/platform-admin.authorizer.js';
import {
  AuthProvider,
  type AuthResult,
} from '../../../../src/modules/identity/ports/auth-provider.js';

const EXTERNAL_ENV = {
  AUTH_MODE: 'external',
  AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks',
  AUTH_EXTERNAL_ISSUER: 'https://idp.test',
  AUTH_EXTERNAL_AUDIENCE: 'api',
  AUTH_EXTERNAL_ALGORITHMS: 'RS256',
  AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
  AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
};
const LOCAL_ENV = {
  AUTH_MODE: 'local',
  BETTER_AUTH_SECRET: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
  AUTH_BASE_URL: 'http://localhost:3000',
};

class FixedProvider extends AuthProvider {
  constructor(private readonly result: AuthResult) {
    super();
  }
  authenticate(): Promise<AuthResult> {
    return Promise.resolve(this.result);
  }
}
const admin = (
  kind: 'EXTERNAL_BEARER' | 'BEARER_SESSION',
  authenticatedAt: Date | undefined,
): AuthResult => ({
  kind: 'AUTHENTICATED',
  principal: { type: 'user', id: 'u1' },
  credential: { kind },
  isPlatformAdmin: true,
  authenticatedAt,
  emailVerified: true,
  verifiedEmail: undefined,
  sessionId: kind === 'BEARER_SESSION' ? 's1' : undefined,
});
const bearerRequest = () => {
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  req.rawHeaders = ['authorization', 'Bearer t0k3n'];
  req.headers = { authorization: 'Bearer t0k3n' };
  return req;
};

/** Review M-1/M-2 (3D): Bull Board dùng CÙNG quyết định nhân viên với `PlatformStaffGuard` (addendum A1.2). */
describe('PlatformAdminAuthorizer: the dashboard uses the staff access decision', () => {
  const build = (
    env: Record<string, string>,
    r: AuthResult,
    stepUp?: StaffStepUp,
  ) => {
    // Dashboard chạy ở worker; các config còn lại dùng mặc định.
    for (const [k, v] of Object.entries({ APP_ROLE: 'worker', ...env }))
      vi.stubEnv(k, v);
    return new PlatformAdminAuthorizer(
      new FixedProvider(r),
      new IdentityMetrics(),
      identityConfig(),
      identityGuardConfig(),
      appConfig(),
      httpConfig(),
      stepUp,
    );
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('M-1: an external admin without a fresh auth_time is refused (reauthentication_required); a fresh one passes', async () => {
    const stale = build(EXTERNAL_ENV, admin('EXTERNAL_BEARER', undefined));
    expect(await stale.authorize(bearerRequest())).toMatchObject({
      allowed: false,
      error: IdentityErrors.REAUTHENTICATION_REQUIRED,
    });
    const fresh = build(EXTERNAL_ENV, admin('EXTERNAL_BEARER', new Date()));
    expect(await fresh.authorize(bearerRequest())).toEqual({ allowed: true });
  });
});
