import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../../src/core/config/index.js';
import { RequestContext } from '../../../../src/core/context/index.js';
import {
  PreAuthRateLimiter,
  httpConfig,
} from '../../../../src/core/http/index.js';
import { AuthState } from '../../../../src/modules/identity/http/auth-state.js';
import { PrincipalResolver } from '../../../../src/modules/identity/http/principal-resolver.js';
import { IdentityMetrics } from '../../../../src/modules/identity/identity-metrics.js';
import { identityConfig } from '../../../../src/modules/identity/identity.config.js';
import {
  AuthProvider,
  type AuthResult,
} from '../../../../src/modules/identity/ports/auth-provider.js';
import { OrgCredentialAuthenticator } from '../../../../src/modules/identity/ports/org-credential-authenticator.js';

const identity = {
  mode: 'local',
  cookiePrefix: 'app',
  apiKeyHeader: 'x-api-key',
  baseUrl: 'http://localhost:3000',
};
const authed: AuthResult = {
  kind: 'AUTHENTICATED',
  principal: { type: 'user', id: 'u1' },
  credential: { kind: 'BEARER_SESSION' },
  isPlatformAdmin: false,
  authenticatedAt: new Date(),
  emailVerified: true,
  verifiedEmail: 'u1@example.test',
};

function request(
  headers: [string, string][],
  method = 'GET',
): IncomingMessage & { ip: string } {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.rawHeaders = headers.flat();
  req.headers = Object.fromEntries(
    headers.map(([k, v]) => [k.toLowerCase(), v]),
  );
  return Object.assign(req, { ip: '198.51.100.1' });
}

async function build(
  opts: { orgAuthenticator?: OrgCredentialAuthenticator } = {},
) {
  const provider = {
    authenticate: vi.fn(async (): Promise<AuthResult> => authed),
  };
  const preAuth = {
    consume: vi.fn(async () => undefined),
    refund: vi.fn(async () => undefined),
  };
  const mod = await Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true })],
    providers: [
      PrincipalResolver,
      AuthState,
      RequestContext,
      IdentityMetrics,
      { provide: AuthProvider, useValue: provider },
      { provide: PreAuthRateLimiter, useValue: preAuth },
      { provide: identityConfig.KEY, useValue: identity },
      { provide: appConfig.KEY, useValue: { serviceName: 'app' } },
      {
        provide: httpConfig.KEY,
        useValue: { corsOrigins: ['http://localhost:3000'] },
      },
      ...(opts.orgAuthenticator
        ? [
            {
              provide: OrgCredentialAuthenticator,
              useValue: opts.orgAuthenticator,
            },
          ]
        : []),
    ],
  }).compile();
  return {
    resolver: mod.get(PrincipalResolver),
    state: mod.get(AuthState),
    ctx: mod.get(RequestContext),
    cls: mod.get(ClsService),
    provider,
    preAuth,
  };
}
const res = (req: IncomingMessage) => new ServerResponse(req);

describe('PrincipalResolver.ensure (spec SP3 §5.2, T6, U18)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('anonymous: the second call is a no-op', async () => {
    const t = await build();
    const set = vi.spyOn(t.state, 'set');
    const req = request([]);
    await t.cls.run(async () => {
      await t.resolver.ensure(req, res(req));
      await t.resolver.ensure(req, res(req));
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(t.provider.authenticate).not.toHaveBeenCalled();
  });
  it('authenticated: the provider runs once across two calls and the principal is set', async () => {
    const t = await build();
    const req = request([['Authorization', 'Bearer tok']]);
    await t.cls.run(async () => {
      await t.resolver.ensure(req, res(req));
      await t.resolver.ensure(req, res(req));
      expect(t.ctx.principal()).toEqual({ type: 'user', id: 'u1' });
    });
    expect(t.provider.authenticate).toHaveBeenCalledTimes(1);
  });
  it('the first call throws (ambiguous credentials) and a later call does not run again', async () => {
    const t = await build();
    const req = request([
      ['Authorization', 'Bearer a'],
      ['Authorization', 'Bearer b'],
    ]);
    await t.cls.run(async () => {
      await expect(t.resolver.ensure(req, res(req))).rejects.toMatchObject({
        error: { code: 'ambiguous_credentials' },
      });
      await expect(t.resolver.ensure(req, res(req))).resolves.toBeUndefined();
    });
    expect(t.provider.authenticate).not.toHaveBeenCalled();
  });
  it('an oak_ key never reaches Better Auth: REJECTED without an authenticator, pre-auth consumed once', async () => {
    const t = await build();
    const req = request([['x-api-key', 'OAK_abc']]);
    await t.cls.run(async () => {
      await t.resolver.ensure(req, res(req));
      expect(t.state.get()).toEqual({ kind: 'REJECTED' });
    });
    expect(t.provider.authenticate).not.toHaveBeenCalled();
    expect(t.preAuth.consume).toHaveBeenCalledTimes(1);
    expect(t.preAuth.refund).not.toHaveBeenCalled();
  });
  it('an oak_ key goes to the OrgCredentialAuthenticator when one is installed (3D), refunded on success', async () => {
    const orgAuth = {
      authenticate: vi.fn(async (): Promise<AuthResult> => ({
        ...authed,
        credential: { kind: 'API_KEY', id: 'k1' },
      })),
    };
    const t = await build({ orgAuthenticator: orgAuth });
    const req = request([['x-api-key', 'oak_abc']]);
    await t.cls.run(() => t.resolver.ensure(req, res(req)));
    expect(orgAuth.authenticate).toHaveBeenCalledWith('oak_abc');
    expect(t.provider.authenticate).not.toHaveBeenCalled();
    expect(t.preAuth.refund).toHaveBeenCalledTimes(1);
  });
  it('outside a CLS context it fails loud', async () => {
    const t = await build();
    const req = request([]);
    await expect(t.resolver.ensure(req, res(req))).rejects.toThrow();
  });
});
