import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import '../../../../src/modules/notifications/notifications.config.js';
import {
  identityConfig,
  identityGuardConfig,
  authDatabaseConfig,
  isBetterAuthMode,
  isExternalMode,
  effectiveCookiePrefix,
  effectiveTwoFactorIssuer,
  effectiveJwtIssuer,
  effectiveJwtAudience,
  idpJwksAttemptTimeoutMs,
} from '../../../../src/modules/identity/identity.config.js';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';

const SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0';
const base: Record<string, string> = {
  APP_ROLE: 'api',
  NODE_ENV: 'development',
  REDIS_URL: 'redis://localhost:6379',
  DB_HOST: 'h',
  DB_NAME: 'n',
  DB_APP_PASSWORD: 'p',
  DB_AUTH_PASSWORD: 'p',
  FIELD_ENCRYPTION_KEYS: JSON.stringify({
    k1: Buffer.alloc(32).toString('base64'),
  }),
  FIELD_ENCRYPTION_ACTIVE_KID: 'k1',
  BETTER_AUTH_SECRET: SECRET,
  AUTH_BASE_URL: 'http://localhost:3000',
  AUTH_SECURE_COOKIES: 'false',
};
const EXTERNAL_MIN = {
  AUTH_MODE: 'external',
  AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks',
  AUTH_EXTERNAL_ISSUER: 'https://idp.test',
  AUTH_EXTERNAL_AUDIENCE: 'api',
  AUTH_EXTERNAL_ALGORITHMS: 'RS256',
  AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
  AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
};
const stub = (env: Record<string, string>) => {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
};
const fails = (env: Record<string, string>, msg: RegExp) => {
  stub(env);
  expect(() => validateAllConfigs()).toThrow(msg);
};

describe('identity config rules (spec §5.15)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts the local defaults', () => {
    stub({});
    expect(() => validateAllConfigs()).not.toThrow();
  });

  it.each([
    [{ BETTER_AUTH_SECRET: '' }, /BETTER_AUTH_SECRET is required/],
    [
      { BETTER_AUTH_SECRET: 'short' },
      /BETTER_AUTH_SECRET must be at least 32 characters/,
    ],
    [{ AUTH_BASE_URL: '' }, /AUTH_BASE_URL is required/],
    [{ DB_AUTH_PASSWORD: '' }, /DB_AUTH_PASSWORD is required/],
    [
      { AUTH_MODE: 'hybrid' },
      /AUTH_OIDC_PROVIDER_ID, AUTH_OIDC_DISCOVERY_URL and AUTH_OIDC_CLIENT_ID are required/,
    ],
    [
      { AUTH_MODE: 'external' },
      /AUTH_EXTERNAL_JWKS_URL, AUTH_EXTERNAL_ISSUER, AUTH_EXTERNAL_AUDIENCE, AUTH_EXTERNAL_ALGORITHMS, AUTH_EXTERNAL_USER_CLAIM and AUTH_EXTERNAL_USER_CLAIM_VALUE are required/,
    ],
    [
      { AUTH_GOOGLE_CLIENT_ID: 'x' },
      /AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET must be set together/,
    ],
    [
      { AUTH_EXTERNAL_ADMIN_CLAIM: 'roles' },
      /AUTH_EXTERNAL_ADMIN_CLAIM and AUTH_EXTERNAL_ADMIN_VALUE must be set together/,
    ],
    [
      { AUTH_PASSWORD_MIN_LENGTH: '64', AUTH_PASSWORD_MAX_LENGTH: '64' },
      /AUTH_PASSWORD_MIN_LENGTH must be less than AUTH_PASSWORD_MAX_LENGTH/,
    ],
    [
      { AUTH_COOKIE_SAMESITE: 'none' },
      /AUTH_COOKIE_SAMESITE=none requires AUTH_SECURE_COOKIES=true/,
    ],
    [
      { AUTH_API_KEY_HEADER: 'Authorization' },
      /AUTH_API_KEY_HEADER must match/,
    ],
    [
      { AUTH_API_KEY_HEADER: 'cookie' },
      /AUTH_API_KEY_HEADER must not be a reserved header/,
    ],
    [
      { AUTH_API_KEY_HEADER: 'x-machine-key' },
      /AUTH_API_KEY_HEADER .* must be redacted/,
    ],
    [{ AUTH_COOKIE_PREFIX: 'My App' }, /AUTH_COOKIE_PREFIX/],
    [
      { AUTH_EXTERNAL_TOKEN_COOKIE: '__Host-token' },
      /AUTH_EXTERNAL_TOKEN_COOKIE/,
    ],
    [
      // EXTERNAL_COOKIE_PATTERN forbids `.`, and Better Auth cookie names are always
      // `<prefix>.xxx`, so this is rejected by the pattern, not by a name-clash check.
      {
        AUTH_COOKIE_PREFIX: 'app',
        AUTH_EXTERNAL_TOKEN_COOKIE: 'app.session_token',
      },
      /AUTH_EXTERNAL_TOKEN_COOKIE must match/,
    ],
    [{ AUTH_EXTERNAL_ALGORITHMS: 'HS256' }, /AUTH_EXTERNAL_ALGORITHMS/],
    [{ AUTH_EXTERNAL_ALGORITHMS: 'none' }, /AUTH_EXTERNAL_ALGORITHMS/],
    [
      {
        AUTH_MODE: 'hybrid',
        AUTH_OIDC_PROVIDER_ID: 'google',
        AUTH_OIDC_DISCOVERY_URL:
          'https://idp.test/.well-known/openid-configuration',
        AUTH_OIDC_CLIENT_ID: 'c',
        AUTH_OIDC_CLIENT_SECRET: 's',
      },
      /AUTH_OIDC_PROVIDER_ID must not be "google"/,
    ],
    [
      { AUTH_TRUSTED_PROVIDERS: 'google' },
      /AUTH_TRUSTED_PROVIDERS contains a provider that is not enabled: google/,
    ],
    [
      { AUTH_BASE_URL: 'http://app.example.test' },
      /AUTH_SECURE_COOKIES=false is only allowed/,
    ],
    [{ NODE_ENV: 'production' }, /AUTH_SECURE_COOKIES=false is only allowed/],
    [
      { AUTH_COOKIE_DOMAIN: 'example.test' },
      /AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED=true/,
    ],
    [
      {
        AUTH_COOKIE_DOMAIN: 'example.test',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      /host of AUTH_BASE_URL and every HTTP_CORS_ORIGINS entry must be under AUTH_COOKIE_DOMAIN/,
    ],
    [
      {
        AUTH_COOKIE_DOMAIN: 'localhost',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      /AUTH_COOKIE_DOMAIN must have at least two labels/,
    ],
    // §5.4 condition 3 / ruling S2-R23: reject public suffixes (ICANN and private PSL
    // sections) and IP literals, even though they clear the "at least two labels" check.
    [
      {
        AUTH_BASE_URL: 'https://co.uk',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_COOKIE_DOMAIN: 'co.uk',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      /AUTH_COOKIE_DOMAIN must not be a public suffix/,
    ],
    [
      {
        AUTH_BASE_URL: 'https://github.io',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_COOKIE_DOMAIN: 'github.io',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      /AUTH_COOKIE_DOMAIN must not be a public suffix/,
    ],
    [
      {
        AUTH_BASE_URL: 'https://127.0.0.1',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_COOKIE_DOMAIN: '127.0.0.1',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      /AUTH_COOKIE_DOMAIN must not be an IP literal/,
    ],
    [
      {
        AUTH_COOKIE_DOMAIN: 'EXAMPLE.test',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      /AUTH_COOKIE_DOMAIN must be lowercase/,
    ],
    [
      {
        AUTH_COOKIE_DOMAIN: '.example.test',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
      },
      /AUTH_COOKIE_DOMAIN must not start or end with a dot/,
    ],
  ])('%j is rejected', (env, msg) => fails(env, msg));

  it('accepts a parent cookie domain covering the base URL and every CORS origin, with the explicit trust flag', () => {
    stub({
      AUTH_BASE_URL: 'https://api.example.test',
      AUTH_SECURE_COOKIES: 'true',
      HTTP_CORS_ORIGINS: 'https://app.example.test',
      AUTH_COOKIE_DOMAIN: 'example.test',
      AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('accepts a cookie domain under a public-suffix registrable domain (app.example.co.uk)', () => {
    stub({
      AUTH_BASE_URL: 'https://app.example.co.uk',
      AUTH_SECURE_COOKIES: 'true',
      AUTH_COOKIE_DOMAIN: 'example.co.uk',
      AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('accepts http://127.0.0.1 as AUTH_BASE_URL in development with secure cookies off', () => {
    stub({ AUTH_BASE_URL: 'http://127.0.0.1', AUTH_SECURE_COOKIES: 'false' });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('external mode: the idp-jwks attempt timeout must be below the jose JWKS timeout (Task 13 carry-forward)', () => {
    const msg =
      /resilience timeout of provider "idp-jwks" \(\d+; .*\) must be less than AUTH_EXTERNAL_JWKS_TIMEOUT_MS/;
    // S2-R56: only the required external variables → boots (derived idp-jwks default, 5000 / (2 + 2) = 1250).
    stub(EXTERNAL_MIN);
    expect(() => validateAllConfigs()).not.toThrow();
    expect(idpJwksAttemptTimeoutMs(5000, 2)).toBe(1250);
    stub({ ...EXTERNAL_MIN, AUTH_EXTERNAL_JWKS_TIMEOUT_MS: '2' });
    expect(() => validateAllConfigs()).not.toThrow();
    // Only an explicit operator override into a conflict fails.
    fails(
      {
        ...EXTERNAL_MIN,
        RESILIENCE_OVERRIDES: JSON.stringify({
          'idp-jwks': { timeoutMs: 5000 },
        }),
      },
      msg,
    );
    fails(
      {
        ...EXTERNAL_MIN,
        RESILIENCE_OVERRIDES: JSON.stringify({
          'idp-jwks': { timeoutMs: 4999 },
        }),
        AUTH_EXTERNAL_JWKS_TIMEOUT_MS: '4999',
      },
      msg,
    );
    stub({
      ...EXTERNAL_MIN,
      RESILIENCE_OVERRIDES: JSON.stringify({ 'idp-jwks': { timeoutMs: 2000 } }),
    });
    expect(() => validateAllConfigs()).not.toThrow();
    // An overridden retry count only changes the derived default, which stays below the jose timeout.
    stub({
      ...EXTERNAL_MIN,
      RESILIENCE_OVERRIDES: JSON.stringify({ 'idp-jwks': { retries: 0 } }),
    });
    expect(() => validateAllConfigs()).not.toThrow();
    stub({ ...EXTERNAL_MIN, AUTH_EXTERNAL_JWKS_TIMEOUT_MS: '1' });
    expect(() => validateAllConfigs()).toThrow(msg);
    // local/hybrid never fetch the IdP JWKS: the rule does not apply.
    stub({ AUTH_EXTERNAL_JWKS_TIMEOUT_MS: '100' });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('external mode needs no Better Auth secret nor auth DB password', () => {
    stub({
      AUTH_MODE: 'external',
      BETTER_AUTH_SECRET: '',
      DB_AUTH_PASSWORD: '',
      AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks',
      AUTH_EXTERNAL_ISSUER: 'https://idp.test',
      AUTH_EXTERNAL_AUDIENCE: 'api',
      AUTH_EXTERNAL_ALGORITHMS: 'RS256',
      AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
      AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('production: https base URL, secure cookies, rate limit on, strong secret, https IdP URLs', () => {
    fails(
      {
        NODE_ENV: 'production',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_BASE_URL: 'http://api.example.test',
      },
      /AUTH_BASE_URL must be https in production/,
    );
    fails(
      {
        NODE_ENV: 'production',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_BASE_URL: 'https://api.example.test',
        AUTH_RATE_LIMIT_ENABLED: 'false',
      },
      /AUTH_RATE_LIMIT_ENABLED must be true in production/,
    );
    fails(
      {
        NODE_ENV: 'production',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_BASE_URL: 'https://api.example.test',
        BETTER_AUTH_SECRET: 'a'.repeat(40),
      },
      /BETTER_AUTH_SECRET must contain at least 16 distinct characters/,
    );
  });
  it('production: HTTP_CORS_ORIGINS and AUTH_ERROR_URL must be https (M2)', () => {
    fails(
      {
        NODE_ENV: 'production',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_BASE_URL: 'https://api.example.test',
        HTTP_CORS_ORIGINS: 'http://app.example.test',
      },
      /HTTP_CORS_ORIGINS entry "http:\/\/app\.example\.test" must be https in production/,
    );
    // AUTH_ERROR_URL only clears the (all-env) trusted-origin rule when it shares an origin with a
    // CORS entry or AUTH_BASE_URL; AUTH_BASE_URL is forced https above, so the only way an http
    // AUTH_ERROR_URL passes that rule is a matching http CORS entry — this exercises the
    // AUTH_ERROR_URL-specific message, checked before the CORS one.
    fails(
      {
        NODE_ENV: 'production',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_BASE_URL: 'https://api.example.test',
        HTTP_CORS_ORIGINS: 'http://app.example.test',
        AUTH_ERROR_URL: 'http://app.example.test/error',
      },
      /AUTH_ERROR_URL must be https in production/,
    );
  });
  it('production: AUTH_REQUIRE_EMAIL_VERIFICATION must stay true (N1)', () => {
    fails(
      {
        NODE_ENV: 'production',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_BASE_URL: 'https://api.example.test',
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      },
      /AUTH_REQUIRE_EMAIL_VERIFICATION must be true in production/,
    );
  });
  it('development/test: http HTTP_CORS_ORIGINS and AUTH_ERROR_URL still boot (unchanged outside production)', () => {
    stub({
      HTTP_CORS_ORIGINS: 'http://app.example.test',
      AUTH_ERROR_URL: 'http://app.example.test/error',
    });
    expect(() => validateAllConfigs()).not.toThrow();
    stub({
      NODE_ENV: 'test',
      HTTP_CORS_ORIGINS: 'http://app.example.test',
      AUTH_ERROR_URL: 'http://app.example.test/error',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });
});

describe('identity configuration boundaries', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts blank optional numeric values emitted by env:example', () => {
    stub({ DB_AUTH_PORT: '', AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC: '' });
    expect(() => validateAllConfigs()).not.toThrow();
  });

  it.each([
    [{ DB_AUTH_CONNECTION_TIMEOUT_MS: '0' }, /DB_AUTH_CONNECTION_TIMEOUT_MS/],
    [{ DB_AUTH_POOL_MAX: '-1' }, /DB_AUTH_POOL_MAX/],
    [{ DB_AUTH_PORT: '65536' }, /DB_AUTH_PORT/],
    [{ AUTH_JWT_EXPIRES_IN_SEC: '0' }, /AUTH_JWT_EXPIRES_IN_SEC/],
    [{ AUTH_LOCKOUT_MAX_FAILURES: '0' }, /AUTH_LOCKOUT_MAX_FAILURES/],
    [{ AUTH_LOCKOUT_WINDOW_SEC: '0' }, /AUTH_LOCKOUT_WINDOW_SEC/],
    [{ AUTH_LOCKOUT_BLOCK_SEC: '0' }, /AUTH_LOCKOUT_BLOCK_SEC/],
    [
      { AUTH_REGISTERED_RECONCILE_CRON: 'invalid' },
      /AUTH_REGISTERED_RECONCILE_CRON/,
    ],
    [{ AUTH_PURGE_TZ: 'Invalid/Timezone' }, /AUTH_PURGE_TZ/],
    [
      { AUTH_BASE_URL: 'http://localhost.evil.test' },
      /AUTH_SECURE_COOKIES=false/,
    ],
    [{ AUTH_BASE_URL: 'https://localhost' }, /AUTH_SECURE_COOKIES=false/],
    [
      { AUTH_EXTERNAL_ADMIN_VALUE: 'admin' },
      /AUTH_EXTERNAL_ADMIN_CLAIM and AUTH_EXTERNAL_ADMIN_VALUE/,
    ],
    [
      { AUTH_GOOGLE_CLIENT_SECRET: 'secret' },
      /AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET/,
    ],
    [{ APP_SERVICE_NAME: 'a'.repeat(33) }, /AUTH_COOKIE_PREFIX/],
    [{ AUTH_PASSWORD_MAX_LENGTH: '513' }, /AUTH_PASSWORD_MAX_LENGTH/],
    [{ AUTH_JWT_EXPIRES_IN_SEC: '3601' }, /AUTH_JWT_EXPIRES_IN_SEC/],
    [
      { AUTH_SESSION_UPDATE_AGE_SEC: '604800' },
      /AUTH_SESSION_UPDATE_AGE_SEC must be less than AUTH_SESSION_EXPIRES_IN_SEC/,
    ],
    [
      { AUTH_SESSION_FRESH_AGE_SEC: '604801' },
      /AUTH_SESSION_FRESH_AGE_SEC must be at most AUTH_SESSION_EXPIRES_IN_SEC/,
    ],
    [
      { AUTH_SESSION_UPDATE_AGE_SEC: '599' },
      /AUTH_SESSION_UPDATE_AGE_SEC must be at least AUTH_SESSION_FRESH_AGE_SEC/,
    ],
    [
      { AUTH_JWKS_GRACE_PERIOD_SEC: '899' },
      /AUTH_JWKS_GRACE_PERIOD_SEC must be at least AUTH_JWT_EXPIRES_IN_SEC/,
    ],
    [
      { AUTH_EXTERNAL_JWKS_COOLDOWN_MS: '600001' },
      /AUTH_EXTERNAL_JWKS_COOLDOWN_MS must be at most AUTH_EXTERNAL_JWKS_CACHE_MAX_AGE_MS/,
    ],
  ])('rejects invalid boundary %j', (env, message) => fails(env, message));

  it('accepts a custom API key header only with explicit redaction', () => {
    stub({
      AUTH_API_KEY_HEADER: 'x-machine-key',
      LOG_EXTRA_REDACT_PATHS: 'req.headers["x-machine-key"]',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });

  it('accepts enabled Google and OIDC providers in hybrid mode', () => {
    stub({
      AUTH_MODE: 'hybrid',
      AUTH_GOOGLE_CLIENT_ID: 'g',
      AUTH_GOOGLE_CLIENT_SECRET: 's',
      AUTH_OIDC_PROVIDER_ID: 'company',
      AUTH_OIDC_DISCOVERY_URL: 'https://idp.test/discovery',
      AUTH_OIDC_CLIENT_ID: 'c',
      AUTH_OIDC_CLIENT_SECRET: 's',
      AUTH_TRUSTED_PROVIDERS: 'google,company',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });

  it('allows migrate without DB_AUTH_PASSWORD', () => {
    stub({ APP_ROLE: 'migrate', DB_AUTH_PASSWORD: '' });
    expect(() => validateAllConfigs()).not.toThrow();
  });

  it('rejects an unrelated CORS host even when the base URL is covered', () => {
    fails(
      {
        AUTH_BASE_URL: 'https://api.example.test',
        AUTH_SECURE_COOKIES: 'true',
        AUTH_COOKIE_DOMAIN: 'example.test',
        AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
        HTTP_CORS_ORIGINS: 'https://evil-example.test',
      },
      /every HTTP_CORS_ORIGINS/,
    );
  });
});

describe('identity defaults and production rules', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('provides session defaults, optional external cookie and helper fallbacks', () => {
    stub({});
    const id = identityConfig();
    expect(id).toMatchObject({
      mode: 'local',
      cookieSameSite: 'lax',
      trustedProviders: [],
      externalTokenCookie: undefined,
      jwtExpiresInSec: 900,
      sessionExpiresInSec: 604800,
    });
    expect(identityGuardConfig()).toMatchObject({
      lockoutMaxFailures: 10,
      lockoutWindowSec: 900,
      lockoutBlockSec: 900,
    });
    expect(authDatabaseConfig()).toMatchObject({
      poolMax: 5,
      connectionTimeoutMs: 3000,
    });
    expect(effectiveCookiePrefix(id, { serviceName: 'app' })).toBe('app');
    expect(effectiveTwoFactorIssuer(id, { serviceName: 'app' })).toBe('app');
    expect(effectiveJwtIssuer(id)).toBe('http://localhost:3000');
    expect(effectiveJwtAudience(id)).toBe('http://localhost:3000');
    const overrides = {
      ...id,
      cookiePrefix: 'custom',
      twoFactorIssuer: 'Issuer',
      jwtIssuer: 'iss',
      jwtAudience: 'aud',
    };
    expect(effectiveCookiePrefix(overrides, { serviceName: 'app' })).toBe(
      'custom',
    );
    expect(effectiveTwoFactorIssuer(overrides, { serviceName: 'app' })).toBe(
      'Issuer',
    );
    expect(effectiveJwtIssuer(overrides)).toBe('iss');
    expect(effectiveJwtAudience(overrides)).toBe('aud');
    expect(() => effectiveJwtIssuer({ ...id, baseUrl: undefined })).toThrow(
      /AUTH_BASE_URL/,
    );
  });

  it.each(['local', 'hybrid', 'external', undefined])(
    'selects raw mode %s',
    (mode) => {
      expect(isBetterAuthMode({ AUTH_MODE: mode })).toBe(mode !== 'external');
      expect(isExternalMode({ AUTH_MODE: mode })).toBe(mode === 'external');
    },
  );

  it('accepts external mode with no base URL or Better Auth credentials', () => {
    stub({
      AUTH_MODE: 'external',
      AUTH_BASE_URL: '',
      AUTH_SECURE_COOKIES: 'true',
      BETTER_AUTH_SECRET: '',
      DB_AUTH_PASSWORD: '',
      AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks',
      AUTH_EXTERNAL_ISSUER: 'idp',
      AUTH_EXTERNAL_AUDIENCE: 'api,web',
      AUTH_EXTERNAL_ALGORITHMS: 'RS256,ES256',
      AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
      AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
    });
    expect(() => validateAllConfigs()).not.toThrow();
    expect(identityConfig().externalTokenCookie).toBeUndefined();
  });

  it('external email claim: empty by default (off), verified claim defaults to email_verified (spec SP3 §5.2)', () => {
    stub({});
    expect(identityConfig()).toMatchObject({
      externalEmailClaim: undefined,
      externalEmailVerifiedClaim: 'email_verified',
    });
    stub({
      ...EXTERNAL_MIN,
      AUTH_EXTERNAL_EMAIL_CLAIM: 'email',
      AUTH_EXTERNAL_EMAIL_VERIFIED_CLAIM: 'mail_ok',
    });
    expect(identityConfig()).toMatchObject({
      externalEmailClaim: 'email',
      externalEmailVerifiedClaim: 'mail_ok',
    });
  });

  it('skips the cookie-domain, secure-cookie and effective-prefix rules in external mode', () => {
    // Each override below would fail its rule in local/hybrid mode; external mode never mounts
    // Better Auth, so these Better-Auth-only cookie rules must not run at all.
    stub({
      AUTH_MODE: 'external',
      AUTH_BASE_URL: '',
      AUTH_SECURE_COOKIES: 'false',
      DB_AUTH_PASSWORD: '',
      APP_SERVICE_NAME: 'a'.repeat(33),
      AUTH_COOKIE_DOMAIN: 'example.test',
      AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks',
      AUTH_EXTERNAL_ISSUER: 'idp',
      AUTH_EXTERNAL_AUDIENCE: 'api',
      AUTH_EXTERNAL_ALGORITHMS: 'RS256',
      AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
      AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });

  it('warns once (structured JSON on stderr) and ignores Better Auth/OIDC variables in modes that do not use them (M3)', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stub({
      AUTH_MODE: 'external',
      AUTH_BASE_URL: '',
      DB_AUTH_PASSWORD: '',
      AUTH_GOOGLE_CLIENT_ID: 'g',
      AUTH_GOOGLE_CLIENT_SECRET: 's',
      AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks',
      AUTH_EXTERNAL_ISSUER: 'idp',
      AUTH_EXTERNAL_AUDIENCE: 'api',
      AUTH_EXTERNAL_ALGORITHMS: 'RS256',
      AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
      AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
    });
    identityConfig();
    expect(write).toHaveBeenCalledTimes(1);
    const line1: unknown = JSON.parse(String(write.mock.calls[0]?.[0]));
    // N8: `level` là số pino (40 = warn), không phải chuỗi.
    expect(line1).toMatchObject({
      level: 40,
      namespace: 'identity.config',
      msg: expect.stringMatching(
        /AUTH_MODE=external.*AUTH_GOOGLE_CLIENT_ID/,
      ) as unknown as string,
    });
    // Same env → same message → the once-guard suppresses the repeat within this process.
    identityConfig();
    expect(write).toHaveBeenCalledTimes(1);
    write.mockClear();
    stub({
      AUTH_OIDC_DISCOVERY_URL: 'https://idp.test/discovery',
    });
    identityConfig();
    expect(write).toHaveBeenCalledTimes(1);
    const line2: unknown = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(line2).toMatchObject({
      level: 40,
      namespace: 'identity.config',
      msg: expect.stringMatching(
        /outside AUTH_MODE=hybrid.*current: local/,
      ) as unknown as string,
    });
    write.mockRestore();
  });

  it('identity-verify-email-rate: /verify-email may not be looser than the default per-IP limit in production', () => {
    const rule = productionRuleRegistry().find(
      (entry) => entry.name === 'identity-verify-email-rate',
    );
    if (!rule) throw new Error('Missing identity-verify-email-rate rule');
    const guard = identityGuardConfig.schema.parse({});
    const identity = { mode: 'local' };
    expect(rule.rule({ identity, identityGuard: guard })).toBeUndefined();
    // Exactly the default rate (same max per same window) is allowed.
    expect(
      rule.rule({
        identity,
        identityGuard: {
          ...guard,
          verifyEmailRateMax: guard.rateLimitMax,
          verifyEmailRateWindowSec: guard.rateLimitWindowSec,
        },
      }),
    ).toBeUndefined();
    expect(
      rule.rule({
        identity,
        identityGuard: {
          ...guard,
          verifyEmailRateMax: guard.rateLimitMax + 1,
          verifyEmailRateWindowSec: guard.rateLimitWindowSec,
        },
      }),
    ).toMatch(/AUTH_VERIFY_EMAIL_RATE_MAX/);
    // Better Auth is not mounted in external mode: nothing to check.
    expect(
      rule.rule({
        identity: { mode: 'external' },
        identityGuard: { ...guard, verifyEmailRateMax: guard.rateLimitMax * 2 },
      }),
    ).toBeUndefined();
    expect(rule.rule({ identity })).toMatch(/identityGuard/);
  });

  it('checks production IdP URLs and accepts valid production identity values', () => {
    stub({
      AUTH_SECURE_COOKIES: 'true',
      AUTH_BASE_URL: 'https://api.example.test',
    });
    const rule = productionRuleRegistry().find(
      (entry) => entry.name === 'identity-production',
    );
    if (!rule) throw new Error('Missing identity-production rule');
    const identity = identityConfig();
    const values = { identity, identityGuard: identityGuardConfig() };
    expect(rule.rule(values)).toBeUndefined();
    expect(
      rule.rule({
        ...values,
        identity: {
          ...identity,
          oidcDiscoveryUrl: 'http://idp.test/discovery',
        },
      }),
    ).toMatch(/AUTH_OIDC_DISCOVERY_URL/);
    expect(
      rule.rule({
        ...values,
        identity: {
          ...identity,
          mode: 'external',
          externalJwksUrl: 'http://idp.test/jwks',
        },
      }),
    ).toMatch(/AUTH_EXTERNAL_JWKS_URL/);
    expect(
      rule.rule({
        ...values,
        identity: {
          ...identity,
          mode: 'external',
          externalJwksUrl: 'https://idp.test/jwks',
        },
      }),
    ).toBeUndefined();
  });

  it('M2: HTTP_CORS_ORIGINS and AUTH_ERROR_URL must be https in production, isolated', () => {
    const rule = productionRuleRegistry().find(
      (entry) => entry.name === 'identity-trusted-origins-https',
    );
    if (!rule) throw new Error('Missing identity-trusted-origins-https rule');
    expect(
      rule.rule({
        identity: {},
        http: { corsOrigins: ['https://app.example.test'] },
      }),
    ).toBeUndefined();
    expect(
      rule.rule({
        identity: {},
        http: { corsOrigins: ['https://app.example.test', 'http://evil.test'] },
      }),
    ).toMatch(/HTTP_CORS_ORIGINS entry "http:\/\/evil\.test" must be https/);
    expect(
      rule.rule({
        identity: { errorUrl: 'https://app.example.test/error' },
        http: { corsOrigins: ['https://app.example.test'] },
      }),
    ).toBeUndefined();
    expect(
      rule.rule({
        identity: { errorUrl: 'http://app.example.test/error' },
        http: { corsOrigins: ['http://app.example.test'] },
      }),
    ).toMatch(/AUTH_ERROR_URL must be https in production/);
    // no CORS namespace / empty list: no origins to reject.
    expect(rule.rule({ identity: {} })).toBeUndefined();
  });
});

describe('identity secrets are required on the api only', () => {
  afterEach(() => vi.unstubAllEnvs());
  const HYBRID_PUBLIC = {
    AUTH_MODE: 'hybrid',
    AUTH_OIDC_PROVIDER_ID: 'corp',
    AUTH_OIDC_DISCOVERY_URL:
      'https://idp.test/.well-known/openid-configuration',
    AUTH_OIDC_CLIENT_ID: 'c',
  };
  const WORKER = {
    APP_ROLE: 'worker',
    DB_RELAY_PASSWORD: 'p',
    SMTP_HOST: 'mail.example.test',
    MAIL_FROM: 'App <noreply@example.test>',
  };
  it('hybrid: the api needs AUTH_OIDC_CLIENT_SECRET, the worker does not', () => {
    fails(
      HYBRID_PUBLIC,
      /AUTH_OIDC_CLIENT_SECRET is required on the api when AUTH_MODE=hybrid/,
    );
    stub({ ...HYBRID_PUBLIC, ...WORKER });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('the Google client id/secret pair is enforced on the api only', () => {
    fails(
      { AUTH_GOOGLE_CLIENT_ID: 'g' },
      /AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET must be set together on the api/,
    );
    stub({ AUTH_GOOGLE_CLIENT_ID: 'g', ...WORKER });
    expect(() => validateAllConfigs()).not.toThrow();
  });
});
