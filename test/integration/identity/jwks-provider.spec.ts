import type { INestApplication } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { ExternalAuthModule } from '../../../src/modules/identity/infra/jwks/external-auth.module.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const TIMEOUT_MS = 300;
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({
  iss: ISS,
  aud: AUD,
  sub: 'user-1',
  iat: now(),
  exp: now() + 300,
  idtyp: 'user',
  roles: ['reader'],
});

describe('JwksAuthProvider (external mode)', () => {
  let jwks: FakeJwks;
  let app: INestApplication;
  let p: AuthProvider;
  const bearer = async (token: string, provider: AuthProvider = p) =>
    provider.authenticate({
      headers: new Headers(),
      credential: { kind: 'EXTERNAL_BEARER', value: token },
    });
  /** Resolver mới (cache JWKS trống) cho các ca lỗi IdP: resolver của `app` đã cache khoá sau lần verify đầu. */
  const withFreshProvider = async (
    fn: (provider: AuthProvider) => Promise<void>,
  ) => {
    const fresh = await createTestApp([ResilienceModule, ExternalAuthModule]);
    try {
      await fn(fresh.get(AuthProvider));
    } finally {
      await fresh.close();
    }
  };
  beforeAll(async () => {
    jwks = await startFakeJwks();
    const port = new URL(jwks.url).port;
    for (const [k, v] of Object.entries({
      AUTH_MODE: 'external',
      AUTH_EXTERNAL_JWKS_URL: jwks.url,
      AUTH_EXTERNAL_ISSUER: ISS,
      AUTH_EXTERNAL_AUDIENCE: AUD,
      AUTH_EXTERNAL_ALGORITHMS: 'RS256,ES256',
      AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
      AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
      AUTH_EXTERNAL_ADMIN_CLAIM: 'roles',
      AUTH_EXTERNAL_ADMIN_VALUE: 'admin',
      AUTH_EXTERNAL_JWKS_TIMEOUT_MS: String(TIMEOUT_MS),
      RESILIENCE_ALLOWED_SCHEMES: 'http,https',
      RESILIENCE_ALLOWED_PORTS: port,
      RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
    }))
      vi.stubEnv(k, v);
    app = await createTestApp([ResilienceModule, ExternalAuthModule]);
    p = app.get(AuthProvider);
  });
  afterAll(async () => {
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    jwks.slow(0);
    jwks.status(200);
  });

  it('a valid user token authenticates; admin needs the exact array element', async () => {
    expect(await bearer(await jwks.sign(good()))).toMatchObject({
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: 'user-1' },
      credential: { kind: 'EXTERNAL_BEARER' },
      isPlatformAdmin: false,
    });
    expect(
      await bearer(await jwks.sign({ ...good(), roles: ['admin'] })),
    ).toMatchObject({ isPlatformAdmin: true });
    expect(
      await bearer(await jwks.sign({ ...good(), roles: ['admins'] })),
    ).toMatchObject({ isPlatformAdmin: false });
    expect(
      await bearer(await jwks.sign({ ...good(), roles: 'Admin' })),
    ).toMatchObject({ isPlatformAdmin: false });
    expect(
      otel
        .spans('identity.jwt.verify')
        .map((sp) => sp.attributes['identity.auth.result']),
    ).toContain('AUTHENTICATED');
    expect(
      JSON.stringify(
        otel.spans('identity.jwt.verify').map((sp) => sp.attributes),
      ),
    ).not.toContain('user-1');
  });
  it('a cookie token verifies exactly like a header token', async () => {
    expect(
      await p.authenticate({
        headers: new Headers(),
        credential: {
          kind: 'EXTERNAL_COOKIE',
          value: await jwks.sign(good()),
          cookieName: 'idp_token',
        },
      }),
    ).toMatchObject({
      kind: 'AUTHENTICATED',
      credential: { kind: 'EXTERNAL_COOKIE' },
    });
  });
  it.each([
    [
      'missing exp',
      () => {
        const { exp: _e, ...c } = good();
        return c;
      },
    ],
    [
      'missing iat',
      () => {
        const { iat: _i, ...c } = good();
        return c;
      },
    ],
    [
      'missing sub',
      () => {
        const { sub: _s, ...c } = good();
        return c;
      },
    ],
    ['empty sub', () => ({ ...good(), sub: '' })],
    ['sub over 255 chars', () => ({ ...good(), sub: 'x'.repeat(256) })],
    ['wrong iss', () => ({ ...good(), iss: 'https://evil.test' })],
    ['wrong aud', () => ({ ...good(), aud: 'other' })],
    ['machine token', () => ({ ...good(), idtyp: 'app' })],
    [
      'user claim missing',
      () => {
        const { idtyp: _t, ...c } = good();
        return c;
      },
    ],
    ['expired', () => ({ ...good(), exp: now() - 3600 })],
  ])('%s → REJECTED', async (_n, claims) => {
    expect(await bearer(await jwks.sign(claims()))).toEqual({
      kind: 'REJECTED',
    });
  });
  it('alg outside the list, unknown kid, foreign key and a jku pointing elsewhere are REJECTED', async () => {
    expect(await bearer(await jwks.sign(good(), { alg: 'RS512' }))).toEqual({
      kind: 'REJECTED',
    });
    expect(await bearer(await jwks.sign(good(), { kid: 'nope' }))).toEqual({
      kind: 'REJECTED',
    });
    expect(
      await bearer(
        await jwks.sign(good(), {
          foreign: true,
          header: { jku: 'https://evil.test/jwks' },
        }),
      ),
    ).toEqual({ kind: 'REJECTED' });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(good())).toString('base64url')}.`;
    expect(await bearer(unsigned)).toEqual({ kind: 'REJECTED' });
    expect(await bearer('not-a-jwt')).toEqual({ kind: 'REJECTED' });
  });
  it('a slow JWKS beyond the timeout → UNAVAILABLE and the request is really aborted', async () => {
    await withFreshProvider(async (fresh) => {
      jwks.slow(TIMEOUT_MS * 5);
      const before = jwks.closedConnections();
      expect(await bearer(await jwks.sign(good()), fresh)).toEqual({
        kind: 'UNAVAILABLE',
      });
      await vi.waitFor(() =>
        expect(jwks.closedConnections()).toBeGreaterThan(before),
      );
    });
  });
  it.each([404, 500])(
    'a JWKS endpoint answering %i → UNAVAILABLE, not REJECTED (the IdP is broken, not the token)',
    async (code) => {
      await withFreshProvider(async (fresh) => {
        jwks.status(code);
        expect(await bearer(await jwks.sign(good()), fresh)).toEqual({
          kind: 'UNAVAILABLE',
        });
        expect(
          otel
            .spans('identity.jwt.verify')
            .map((sp) => sp.attributes['identity.auth.result']),
        ).toContain('UNAVAILABLE');
      });
    },
  );
  it('session and API key credentials are REJECTED in external mode', async () => {
    for (const kind of ['SESSION_COOKIE', 'BEARER_SESSION', 'API_KEY'] as const)
      expect(
        await p.authenticate({
          headers: new Headers(),
          credential: { kind, value: 'x' },
        }),
      ).toEqual({ kind: 'REJECTED' });
  });
});
