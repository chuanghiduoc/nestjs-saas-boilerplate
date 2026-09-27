import { RequestMethod, type MiddlewareConsumer } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrincipalMiddleware } from '../../../../src/modules/identity/http/principal.middleware.js';
import { IdentityHttpModule } from '../../../../src/modules/identity/identity.module.js';
import { identityConfig } from '../../../../src/modules/identity/identity.config.js';

type MiddlewareConfigProxy = ReturnType<MiddlewareConsumer['apply']>;

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
  AUTH_BASE_PATH: '/api/auth',
};

/** Ghi lại middleware, route bị loại trừ và route áp dụng mà `configure` khai báo. */
function recordConfigure(): {
  applied: unknown[];
  excluded: unknown[];
  forRoutes: unknown[];
} {
  const seen = {
    applied: [] as unknown[],
    excluded: [] as unknown[],
    forRoutes: [] as unknown[],
  };
  const consumer: MiddlewareConsumer = {
    apply: (...middleware: Parameters<MiddlewareConsumer['apply']>) => {
      seen.applied.push(...middleware);
      const proxy: MiddlewareConfigProxy = {
        exclude: (...routes: Parameters<MiddlewareConfigProxy['exclude']>) => {
          seen.excluded.push(...routes);
          return proxy;
        },
        forRoutes: (...routes: unknown[]) => {
          seen.forRoutes.push(...routes);
          return consumer;
        },
      };
      return proxy;
    },
  };
  new IdentityHttpModule(identityConfig()).configure(consumer);
  return seen;
}

describe('IdentityHttpModule.configure', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('local/hybrid: PrincipalMiddleware on every route except the Better Auth mount (review I9)', () => {
    for (const [k, v] of Object.entries(LOCAL_ENV)) vi.stubEnv(k, v);
    expect(recordConfigure()).toEqual({
      applied: [PrincipalMiddleware],
      excluded: [{ path: '/api/auth/{*path}', method: RequestMethod.ALL }],
      forRoutes: ['{*path}'],
    });
  });

  it('external: no mount, so nothing is excluded (review M4: no Nest route may skip credential checks)', () => {
    for (const [k, v] of Object.entries(EXTERNAL_ENV)) vi.stubEnv(k, v);
    expect(recordConfigure()).toEqual({
      applied: [PrincipalMiddleware],
      excluded: [],
      forRoutes: ['{*path}'],
    });
  });
});
