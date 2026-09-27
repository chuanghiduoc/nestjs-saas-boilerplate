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
  /** JWKS của kẻ tấn công, truy cập được (cổng nằm trong allow-list): `jku` trỏ tới nó phải bị bỏ qua. */
  let attacker: FakeJwks;
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
    env: Record<string, string> = {},
  ) => {
    const saved = Object.keys(env).map((k) => [k, process.env[k]] as const);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    let fresh: INestApplication | undefined;
    try {
      fresh = await createTestApp([ResilienceModule, ExternalAuthModule]);
      await fn(fresh.get(AuthProvider));
    } finally {
      await fresh?.close();
      for (const [k, v] of saved) vi.stubEnv(k, v);
    }
  };
  beforeAll(async () => {
    jwks = await startFakeJwks();
    attacker = await startFakeJwks();
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
      RESILIENCE_ALLOWED_PORTS: `${port},${new URL(attacker.url).port}`,
      RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
    }))
      vi.stubEnv(k, v);
    app = await createTestApp([ResilienceModule, ExternalAuthModule]);
    p = app.get(AuthProvider);
  });
  afterAll(async () => {
    await app?.close();
    await jwks?.close();
    await attacker?.close();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    jwks.slow(0);
    jwks.slowNext(0, 0);
    jwks.status(200);
  });

  it('a valid user token authenticates; admin needs the exact string or the exact array element', async () => {
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
      await bearer(await jwks.sign({ ...good(), roles: 'admin' })),
    ).toMatchObject({ isPlatformAdmin: true });
    expect(
      await bearer(await jwks.sign({ ...good(), roles: 'admins' })),
    ).toMatchObject({ isPlatformAdmin: false });
    expect(
      await bearer(await jwks.sign({ ...good(), roles: 'admin reader' })),
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
  it('alg outside the list, unknown kid, none and garbage are REJECTED', async () => {
    expect(await bearer(await jwks.sign(good(), { alg: 'RS512' }))).toEqual({
      kind: 'REJECTED',
    });
    expect(await bearer(await jwks.sign(good(), { kid: 'nope' }))).toEqual({
      kind: 'REJECTED',
    });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(good())).toString('base64url')}.`;
    expect(await bearer(unsigned)).toEqual({ kind: 'REJECTED' });
    expect(await bearer('not-a-jwt')).toEqual({ kind: 'REJECTED' });
  });
  it('a jku pointing at a reachable attacker JWKS serving the signing key is ignored: REJECTED, zero fetches', async () => {
    const token = await attacker.sign(good(), {
      header: { jku: attacker.url },
    });
    expect(await bearer(token)).toEqual({ kind: 'REJECTED' });
    expect(attacker.requests()).toBe(0);
  });
  it('configured typ: a token with another typ is REJECTED, the right typ authenticates', async () => {
    await withFreshProvider(
      async (fresh) => {
        expect(
          await bearer(
            await jwks.sign(good(), { header: { typ: 'JWT' } }),
            fresh,
          ),
        ).toEqual({ kind: 'REJECTED' });
        expect(
          await bearer(
            await jwks.sign(good(), { header: { typ: 'at+jwt' } }),
            fresh,
          ),
        ).toMatchObject({ kind: 'AUTHENTICATED' });
      },
      { AUTH_EXTERNAL_TYP: 'at+jwt' },
    );
  });
  it('configured maxTokenAge: a token issued too long ago is REJECTED even before exp', async () => {
    await withFreshProvider(
      async (fresh) => {
        expect(
          await bearer(await jwks.sign({ ...good(), iat: now() - 600 }), fresh),
        ).toEqual({ kind: 'REJECTED' });
        expect(await bearer(await jwks.sign(good()), fresh)).toMatchObject({
          kind: 'AUTHENTICATED',
        });
      },
      { AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC: '60' },
    );
  });
  it('a slow JWKS beyond the timeout → UNAVAILABLE and the request is really aborted', async () => {
    await withFreshProvider(async (fresh) => {
      jwks.slow(TIMEOUT_MS * 5);
      const before = jwks.abortedConnections();
      expect(await bearer(await jwks.sign(good()), fresh)).toEqual({
        kind: 'UNAVAILABLE',
      });
      await vi.waitFor(
        () => expect(jwks.abortedConnections()).toBeGreaterThan(before),
        { timeout: TIMEOUT_MS * 10 },
      );
    });
  });
  it('the idp-jwks attempt timeout defaults below the jose timeout (S2-R56): a hung first attempt is retried inside the budget', async () => {
    await withFreshProvider(
      async (fresh) => {
        // Default: 300 / (2 + 2) = 75 ms per attempt. With the global 10000 ms attempt timeout the first attempt would
        // hang until jose aborts at 300 ms (UNAVAILABLE); with the derived default it is cut and the retry succeeds.
        jwks.slowNext(1, TIMEOUT_MS * 5);
        expect(await bearer(await jwks.sign(good()), fresh)).toMatchObject({
          kind: 'AUTHENTICATED',
        });
      }, // Backoff kept tiny so the retry deterministically fits in the 300 ms test budget.
      { RESILIENCE_DEFAULT_RETRY_BASE_MS: '1' },
    );
  });
  it.each([404, 500])(
    'a JWKS endpoint answering %i → UNAVAILABLE, not REJECTED (the IdP is broken, not the token)',
    async (code) => {
      await withFreshProvider(async (fresh) => {
        jwks.status(code);
        otel.reset();
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
  it('a JWKS URL blocked by the SSRF allow-list → UNAVAILABLE (misconfiguration, logged at error)', async () => {
    const requestsBefore = jwks.requests();
    await withFreshProvider(
      async (fresh) => {
        expect(await bearer(await jwks.sign(good()), fresh)).toEqual({
          kind: 'UNAVAILABLE',
        });
        expect(jwks.requests()).toBe(requestsBefore);
      },
      { RESILIENCE_ALLOWED_PORTS: '443' },
    );
  });
  it('an unclassified error (IdP key jose refuses: RSA 1024) is thrown, not masked as UNAVAILABLE (S2-R55)', async () => {
    otel.reset();
    await expect(bearer(jwks.signWithWeakKey(good()))).rejects.toThrow(
      TypeError,
    );
    expect(
      otel
        .spans('identity.jwt.verify')
        .map((sp) => sp.attributes['error.type']),
    ).toEqual(['TypeError']);
  });
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
