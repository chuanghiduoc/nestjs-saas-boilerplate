import { z } from 'zod';
import { parse as parseHostname } from 'tldts';
import {
  defineConfig,
  defineConfigRule,
  defineProductionRule,
  numberAt,
  type ConfigOf,
} from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';

export const AUTH_MODES = ['local', 'hybrid', 'external'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export const AUTH_MODE_ENV = 'AUTH_MODE';
export const DEFAULT_AUTH_MODE: AuthMode = 'local';
export const MIN_BETTER_AUTH_SECRET_LENGTH = 32;
export const MIN_SECRET_DISTINCT_CHARS = 16;
/** Chỉ thuật toán bất đối xứng (spec §5.6.3): `none` và `HS*` không bao giờ được nhận. */
export const EXTERNAL_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
export type ExternalAlgorithm = (typeof EXTERNAL_ALGORITHMS)[number];
/** Tên provider của breaker/bulkhead trong `HttpClient` cho fetch JWKS (hằng số, không phải host). */
export const IDP_JWKS_PROVIDER = 'idp-jwks';
const API_KEY_HEADER_PATTERN = /^[a-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'set-auth-token',
  'host',
  'origin',
  'referer',
  'x-app-client-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'content-type',
  'content-length',
  'transfer-encoding',
]);
const COOKIE_PREFIX_PATTERN = /^[a-z0-9-]{1,32}$/;
const EXTERNAL_COOKIE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_REDACTED_API_KEY_HEADER = 'x-api-key';
const LOCAL_HTTP_ORIGINS = ['http://localhost', 'http://127.0.0.1'];
const GOOGLE_PROVIDER_ID = 'google';
const MIN_COOKIE_DOMAIN_LABELS = 2;
const MAX_TCP_PORT = 65535;
/** JWT phát cho dịch vụ khác còn hiệu lực tới `exp` sau khi bị thu hồi (spec §5.6.3, ADR 0010); chặn trần để cửa sổ rủi ro đó luôn ngắn. */
const MAX_JWT_EXPIRES_IN_SEC = 3600;
/** scrypt (better-auth) băm theo độ dài input; chặn trần để tránh DoS bằng mật khẩu khổng lồ, vẫn rộng hơn mọi passphrase thật. */
const MAX_PASSWORD_LENGTH = 512;

const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const positiveInt = z.coerce.number().int().positive();
const optionalText = z
  .string()
  .optional()
  .transform((s) => (s ? s : undefined));
const cron = z
  .string()
  .min(1)
  .refine(isValidCron, 'must be a valid cron expression');
const timezone = z
  .string()
  .min(1)
  .refine(
    (tz) => normalizeTimezone(tz) !== undefined,
    'must be an IANA timezone name',
  );

export const identityConfig = defineConfig(
  'identity',
  {
    mode: 'AUTH_MODE',
    secret: 'BETTER_AUTH_SECRET',
    baseUrl: 'AUTH_BASE_URL',
    basePath: 'AUTH_BASE_PATH',
    secureCookies: 'AUTH_SECURE_COOKIES',
    cookiePrefix: 'AUTH_COOKIE_PREFIX',
    cookieDomain: 'AUTH_COOKIE_DOMAIN',
    cookieDomainAllSubdomainsTrusted:
      'AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED',
    cookieSameSite: 'AUTH_COOKIE_SAMESITE',
    sessionExpiresInSec: 'AUTH_SESSION_EXPIRES_IN_SEC',
    sessionUpdateAgeSec: 'AUTH_SESSION_UPDATE_AGE_SEC',
    sessionFreshAgeSec: 'AUTH_SESSION_FRESH_AGE_SEC',
    passwordMinLength: 'AUTH_PASSWORD_MIN_LENGTH',
    passwordMaxLength: 'AUTH_PASSWORD_MAX_LENGTH',
    requireEmailVerification: 'AUTH_REQUIRE_EMAIL_VERIFICATION',
    emailTokenTtlSec: 'AUTH_EMAIL_TOKEN_TTL_SEC',
    resetTokenTtlSec: 'AUTH_RESET_TOKEN_TTL_SEC',
    googleClientId: 'AUTH_GOOGLE_CLIENT_ID',
    googleClientSecret: 'AUTH_GOOGLE_CLIENT_SECRET',
    trustedProviders: 'AUTH_TRUSTED_PROVIDERS',
    oidcProviderId: 'AUTH_OIDC_PROVIDER_ID',
    oidcDiscoveryUrl: 'AUTH_OIDC_DISCOVERY_URL',
    oidcClientId: 'AUTH_OIDC_CLIENT_ID',
    oidcClientSecret: 'AUTH_OIDC_CLIENT_SECRET',
    oidcScopes: 'AUTH_OIDC_SCOPES',
    twoFactorIssuer: 'AUTH_TWO_FACTOR_ISSUER',
    apiKeyHeader: 'AUTH_API_KEY_HEADER',
    apiKeyDefaultExpiresInSec: 'AUTH_API_KEY_DEFAULT_EXPIRES_IN_SEC',
    jwtIssuer: 'AUTH_JWT_ISSUER',
    jwtAudience: 'AUTH_JWT_AUDIENCE',
    jwtExpiresInSec: 'AUTH_JWT_EXPIRES_IN_SEC',
    jwksRotationIntervalSec: 'AUTH_JWKS_ROTATION_INTERVAL_SEC',
    jwksGracePeriodSec: 'AUTH_JWKS_GRACE_PERIOD_SEC',
    externalJwksUrl: 'AUTH_EXTERNAL_JWKS_URL',
    externalIssuer: 'AUTH_EXTERNAL_ISSUER',
    externalAudience: 'AUTH_EXTERNAL_AUDIENCE',
    externalAlgorithms: 'AUTH_EXTERNAL_ALGORITHMS',
    externalClockToleranceSec: 'AUTH_EXTERNAL_CLOCK_TOLERANCE_SEC',
    externalUserClaim: 'AUTH_EXTERNAL_USER_CLAIM',
    externalUserClaimValue: 'AUTH_EXTERNAL_USER_CLAIM_VALUE',
    externalTokenCookie: 'AUTH_EXTERNAL_TOKEN_COOKIE',
    externalTyp: 'AUTH_EXTERNAL_TYP',
    externalMaxTokenAgeSec: 'AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC',
    externalAdminClaim: 'AUTH_EXTERNAL_ADMIN_CLAIM',
    externalAdminValue: 'AUTH_EXTERNAL_ADMIN_VALUE',
    externalJwksTimeoutMs: 'AUTH_EXTERNAL_JWKS_TIMEOUT_MS',
    externalJwksCooldownMs: 'AUTH_EXTERNAL_JWKS_COOLDOWN_MS',
    externalJwksCacheMaxAgeMs: 'AUTH_EXTERNAL_JWKS_CACHE_MAX_AGE_MS',
  },
  z
    .object({
      mode: z
        .enum(AUTH_MODES)
        .default(DEFAULT_AUTH_MODE)
        .describe('local | hybrid | external (spec SP2 §5.6)'),
      secret: optionalText.describe(
        'Better Auth secret, >= 32 chars; required unless AUTH_MODE=external (secret)',
      ),
      baseUrl: z
        .url()
        .or(z.literal('').transform(() => undefined))
        .optional()
        .describe(
          'Public base URL of the API (links in emails, cookie scope); required unless external',
        ),
      basePath: z
        .string()
        .startsWith('/')
        .default('/api/auth')
        .describe('Mount path of Better Auth routes'),
      secureCookies: z
        .stringbool()
        .default(true)
        .describe(
          'Secure cookies; false only in development/test on http://localhost or http://127.0.0.1',
        ),
      cookiePrefix: optionalText.describe(
        'Better Auth cookie prefix (^[a-z0-9-]{1,32}$); empty = APP_SERVICE_NAME',
      ),
      cookieDomain: optionalText.describe(
        'Parent cookie domain to share cookies across subdomains; empty = host-only cookies',
      ),
      cookieDomainAllSubdomainsTrusted: z
        .stringbool()
        .default(false)
        .describe(
          'Explicit confirmation that no subdomain is controlled by third parties or user content; required with AUTH_COOKIE_DOMAIN',
        ),
      cookieSameSite: z
        .enum(['lax', 'strict', 'none'])
        .default('lax')
        .describe(
          'SameSite of Better Auth cookies (none requires secure cookies)',
        ),
      sessionExpiresInSec: positiveInt
        .default(604800)
        .describe('Session lifetime'),
      sessionUpdateAgeSec: positiveInt
        .default(86400)
        .describe('Refresh the session expiry when older than this'),
      sessionFreshAgeSec: positiveInt
        .default(600)
        .describe(
          'Sensitive operations need a session created within this window',
        ),
      passwordMinLength: positiveInt
        .default(12)
        .describe('Minimum password length'),
      passwordMaxLength: positiveInt
        .max(MAX_PASSWORD_LENGTH)
        .default(128)
        .describe('Maximum password length (rejected before hashing)'),
      requireEmailVerification: z
        .stringbool()
        .default(true)
        .describe('Sign-in requires a verified email'),
      emailTokenTtlSec: positiveInt
        .default(86400)
        .describe('Email verification link lifetime'),
      resetTokenTtlSec: positiveInt
        .default(3600)
        .describe('Password reset link lifetime'),
      googleClientId: optionalText.describe(
        'Google OAuth client id (set together with the secret)',
      ),
      googleClientSecret: optionalText.describe(
        'Google OAuth client secret (secret)',
      ),
      trustedProviders: z
        .string()
        .default('')
        .transform(csv)
        .describe('Provider ids allowed to link by verified email (spec §5.4)'),
      oidcProviderId: optionalText.describe(
        'Generic OIDC provider id (hybrid mode; not "google")',
      ),
      oidcDiscoveryUrl: z
        .url()
        .or(z.literal('').transform(() => undefined))
        .optional()
        .describe('OIDC discovery URL (hybrid mode)'),
      oidcClientId: optionalText.describe('OIDC client id (hybrid mode)'),
      oidcClientSecret: optionalText.describe(
        'OIDC client secret (hybrid mode, secret)',
      ),
      oidcScopes: z
        .string()
        .default('openid,email,profile')
        .transform(csv)
        .describe('OIDC scopes'),
      twoFactorIssuer: optionalText.describe(
        'TOTP issuer label; empty = APP_SERVICE_NAME',
      ),
      apiKeyHeader: z
        .string()
        .default(DEFAULT_REDACTED_API_KEY_HEADER)
        .describe(
          'Header carrying API keys (lowercase token, must be redacted in logs)',
        ),
      apiKeyDefaultExpiresInSec: positiveInt
        .default(7776000)
        .describe('Default API key lifetime'),
      jwtIssuer: optionalText.describe(
        'iss of JWTs issued to other services; empty = origin of AUTH_BASE_URL',
      ),
      jwtAudience: optionalText.describe(
        'aud of JWTs issued to other services; empty = origin of AUTH_BASE_URL',
      ),
      jwtExpiresInSec: positiveInt
        .max(MAX_JWT_EXPIRES_IN_SEC)
        .default(900)
        .describe(
          'Lifetime of issued JWTs (they stay valid until exp after revocation; must stay short)',
        ),
      jwksRotationIntervalSec: positiveInt
        .default(2592000)
        .describe('Rotate the JWT signing key after this long'),
      jwksGracePeriodSec: positiveInt
        .default(604800)
        .describe('Keep a rotated key in the JWKS for this long'),
      externalJwksUrl: z
        .url()
        .or(z.literal('').transform(() => undefined))
        .optional()
        .describe('IdP JWKS URL (external mode)'),
      externalIssuer: optionalText.describe('Expected iss (external mode)'),
      externalAudience: z
        .string()
        .default('')
        .transform(csv)
        .describe('Expected aud values (external mode)'),
      externalAlgorithms: z
        .string()
        .default('')
        .transform(csv)
        .pipe(
          z.array(
            z.enum(EXTERNAL_ALGORITHMS, {
              error: 'AUTH_EXTERNAL_ALGORITHMS accepts only RS*/PS*/ES*/EdDSA',
            }),
          ),
        )
        .describe('Accepted JWS algorithms (asymmetric only)'),
      externalClockToleranceSec: z.coerce
        .number()
        .int()
        .min(0)
        .default(30)
        .describe('Clock skew tolerance for exp/iat/nbf'),
      externalUserClaim: optionalText.describe(
        'Claim that marks user tokens (e.g. idtyp)',
      ),
      externalUserClaimValue: optionalText.describe(
        'Exact value of the user claim (e.g. user)',
      ),
      externalTokenCookie: optionalText.describe(
        'Cookie carrying the IdP token; empty = header only',
      ),
      externalTyp: optionalText.describe('Expected JWT typ header'),
      externalMaxTokenAgeSec: z
        .union([z.literal('').transform(() => undefined), positiveInt])
        .optional()
        .describe('Reject tokens older than this (iat)'),
      externalAdminClaim: optionalText.describe(
        'Claim granting platform admin (set together with the value)',
      ),
      externalAdminValue: optionalText.describe(
        'Exact value (or array element) of the admin claim',
      ),
      externalJwksTimeoutMs: positiveInt
        .default(5000)
        .describe(
          'JWKS fetch timeout (jose); the idp-jwks attempt timeout defaults to it / (retries + 2), an override must stay below it',
        ),
      externalJwksCooldownMs: positiveInt
        .default(30000)
        .describe('Minimum time between JWKS refetches for unknown kids'),
      externalJwksCacheMaxAgeMs: positiveInt
        .default(600000)
        .describe('JWKS cache max age'),
    })
    .superRefine((c, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if (c.mode !== 'external') {
        if (!c.secret)
          issue(
            'secret',
            'BETTER_AUTH_SECRET is required when AUTH_MODE is local or hybrid',
          );
        else if (c.secret.length < MIN_BETTER_AUTH_SECRET_LENGTH)
          issue(
            'secret',
            `BETTER_AUTH_SECRET must be at least ${MIN_BETTER_AUTH_SECRET_LENGTH} characters`,
          );
        if (!c.baseUrl)
          issue(
            'baseUrl',
            'AUTH_BASE_URL is required when AUTH_MODE is local or hybrid',
          );
      }
      if (
        c.mode === 'hybrid' &&
        !(
          c.oidcProviderId &&
          c.oidcDiscoveryUrl &&
          c.oidcClientId &&
          c.oidcClientSecret
        )
      )
        issue(
          'oidcProviderId',
          'AUTH_OIDC_PROVIDER_ID, AUTH_OIDC_DISCOVERY_URL, AUTH_OIDC_CLIENT_ID and AUTH_OIDC_CLIENT_SECRET are required when AUTH_MODE=hybrid',
        );
      if (c.oidcProviderId === GOOGLE_PROVIDER_ID)
        issue('oidcProviderId', 'AUTH_OIDC_PROVIDER_ID must not be "google"');
    })
    .superRefine((c, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if (
        c.mode === 'external' &&
        !(
          c.externalJwksUrl &&
          c.externalIssuer &&
          c.externalAudience.length &&
          c.externalAlgorithms.length &&
          c.externalUserClaim &&
          c.externalUserClaimValue
        )
      )
        issue(
          'externalJwksUrl',
          'AUTH_EXTERNAL_JWKS_URL, AUTH_EXTERNAL_ISSUER, AUTH_EXTERNAL_AUDIENCE, AUTH_EXTERNAL_ALGORITHMS, AUTH_EXTERNAL_USER_CLAIM and AUTH_EXTERNAL_USER_CLAIM_VALUE are required when AUTH_MODE=external',
        );
    })
    .superRefine((c, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if (!c.googleClientId !== !c.googleClientSecret)
        issue(
          'googleClientId',
          'AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET must be set together',
        );
      if (!c.externalAdminClaim !== !c.externalAdminValue)
        issue(
          'externalAdminClaim',
          'AUTH_EXTERNAL_ADMIN_CLAIM and AUTH_EXTERNAL_ADMIN_VALUE must be set together',
        );
      if (c.passwordMinLength >= c.passwordMaxLength)
        issue(
          'passwordMinLength',
          'AUTH_PASSWORD_MIN_LENGTH must be less than AUTH_PASSWORD_MAX_LENGTH',
        );
      if (c.cookieSameSite === 'none' && !c.secureCookies)
        issue(
          'cookieSameSite',
          'AUTH_COOKIE_SAMESITE=none requires AUTH_SECURE_COOKIES=true',
        );
    })
    .superRefine((c, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if (!API_KEY_HEADER_PATTERN.test(c.apiKeyHeader))
        issue(
          'apiKeyHeader',
          `AUTH_API_KEY_HEADER must match ${API_KEY_HEADER_PATTERN}`,
        );
      if (RESERVED_HEADERS.has(c.apiKeyHeader))
        issue(
          'apiKeyHeader',
          'AUTH_API_KEY_HEADER must not be a reserved header',
        );
      if (
        c.cookiePrefix !== undefined &&
        !COOKIE_PREFIX_PATTERN.test(c.cookiePrefix)
      )
        issue(
          'cookiePrefix',
          `AUTH_COOKIE_PREFIX must match ${COOKIE_PREFIX_PATTERN}`,
        );
    })
    .superRefine((c, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if (c.externalTokenCookie !== undefined) {
        // EXTERNAL_COOKIE_PATTERN forbids `.`, and Better Auth cookie names are always
        // `<prefix>.xxx` (§5.4), so a separate name-clash check can never fire — the pattern
        // check below already rejects any value that could collide.
        if (
          !EXTERNAL_COOKIE_PATTERN.test(c.externalTokenCookie) ||
          /^__(Secure|Host)-/.test(c.externalTokenCookie)
        )
          issue(
            'externalTokenCookie',
            `AUTH_EXTERNAL_TOKEN_COOKIE must match ${EXTERNAL_COOKIE_PATTERN} and not start with __Secure- or __Host-`,
          );
      }
    })
    .superRefine((c, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      // Google và OIDC (và do đó trustedProviders) chỉ áp dụng ở local/hybrid: ở external,
      // Better Auth không bao giờ được khởi tạo (§5.5) nên không provider nào được coi là "bật".
      const enabled = new Set([
        ...(c.mode !== 'external' && c.googleClientId
          ? [GOOGLE_PROVIDER_ID]
          : []),
        ...(c.mode === 'hybrid' && c.oidcProviderId ? [c.oidcProviderId] : []),
      ]);
      const notEnabled = c.trustedProviders.filter((p) => !enabled.has(p));
      if (notEnabled.length)
        issue(
          'trustedProviders',
          `AUTH_TRUSTED_PROVIDERS contains a provider that is not enabled: ${notEnabled.join(', ')}`,
        );
      if (c.mode === 'external') {
        const ignored: string[] = [];
        if (c.googleClientId || c.googleClientSecret)
          ignored.push('AUTH_GOOGLE_CLIENT_ID/AUTH_GOOGLE_CLIENT_SECRET');
        if (
          c.oidcProviderId ||
          c.oidcDiscoveryUrl ||
          c.oidcClientId ||
          c.oidcClientSecret
        )
          ignored.push(
            'AUTH_OIDC_PROVIDER_ID/AUTH_OIDC_DISCOVERY_URL/AUTH_OIDC_CLIENT_ID/AUTH_OIDC_CLIENT_SECRET',
          );
        if (c.trustedProviders.length) ignored.push('AUTH_TRUSTED_PROVIDERS');
        if (ignored.length)
          console.warn(
            `[identity.config] ignored because AUTH_MODE=external (Better Auth is not mounted): ${ignored.join(', ')}`,
          );
      } else if (
        c.mode !== 'hybrid' &&
        (c.oidcProviderId ||
          c.oidcDiscoveryUrl ||
          c.oidcClientId ||
          c.oidcClientSecret)
      )
        console.warn(
          `[identity.config] AUTH_OIDC_PROVIDER_ID/AUTH_OIDC_DISCOVERY_URL/AUTH_OIDC_CLIENT_ID/AUTH_OIDC_CLIENT_SECRET are ignored outside AUTH_MODE=hybrid (current: ${c.mode})`,
        );
    }),
);
export type IdentityConfig = ConfigOf<typeof identityConfig>;

export const identityGuardConfig = defineConfig(
  'identityGuard',
  {
    rateLimitEnabled: 'AUTH_RATE_LIMIT_ENABLED',
    rateLimitWindowSec: 'AUTH_RATE_LIMIT_WINDOW_SEC',
    rateLimitMax: 'AUTH_RATE_LIMIT_MAX',
    signinRateWindowSec: 'AUTH_SIGNIN_RATE_WINDOW_SEC',
    signinRateMax: 'AUTH_SIGNIN_RATE_MAX',
    twoFactorRateWindowSec: 'AUTH_TWO_FACTOR_RATE_WINDOW_SEC',
    twoFactorRateMax: 'AUTH_TWO_FACTOR_RATE_MAX',
    emailRateWindowSec: 'AUTH_EMAIL_RATE_WINDOW_SEC',
    emailRateMax: 'AUTH_EMAIL_RATE_MAX',
    lockoutMaxFailures: 'AUTH_LOCKOUT_MAX_FAILURES',
    lockoutWindowSec: 'AUTH_LOCKOUT_WINDOW_SEC',
    lockoutBlockSec: 'AUTH_LOCKOUT_BLOCK_SEC',
    unavailableRetryAfterSec: 'AUTH_UNAVAILABLE_RETRY_AFTER_SEC',
    existingAccountNoticeWindowSec: 'AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC',
    registeredReconcileCron: 'AUTH_REGISTERED_RECONCILE_CRON',
    registeredReconcileTz: 'AUTH_REGISTERED_RECONCILE_TZ',
    registeredReconcileGraceSec: 'AUTH_REGISTERED_RECONCILE_GRACE_SEC',
    registeredReconcileBatchSize: 'AUTH_REGISTERED_RECONCILE_BATCH_SIZE',
    registeredReconcileMaxBatches: 'AUTH_REGISTERED_RECONCILE_MAX_BATCHES',
    purgeCron: 'AUTH_PURGE_CRON',
    purgeTz: 'AUTH_PURGE_TZ',
    purgeBatchSize: 'AUTH_PURGE_BATCH_SIZE',
    purgeMaxBatches: 'AUTH_PURGE_MAX_BATCHES',
  },
  z.object({
    rateLimitEnabled: z
      .stringbool()
      .default(true)
      .describe('Better Auth per-IP rate limit (required in production)'),
    rateLimitWindowSec: positiveInt
      .default(60)
      .describe('Default per-IP window for /api/auth/*'),
    rateLimitMax: positiveInt
      .default(100)
      .describe('Default per-IP max requests per window'),
    signinRateWindowSec: positiveInt
      .default(60)
      .describe('Per-IP window for /sign-in/* and /sign-up/*'),
    signinRateMax: positiveInt
      .default(10)
      .describe('Per-IP max for /sign-in/* and /sign-up/*'),
    twoFactorRateWindowSec: positiveInt
      .default(60)
      .describe('Per-IP window for /two-factor/*'),
    twoFactorRateMax: positiveInt
      .default(10)
      .describe('Per-IP max for /two-factor/*'),
    emailRateWindowSec: positiveInt
      .default(300)
      .describe('Per-IP window for password reset and verification emails'),
    emailRateMax: positiveInt
      .default(3)
      .describe('Per-IP max for password reset and verification emails'),
    lockoutMaxFailures: positiveInt
      .default(10)
      .describe(
        'Failed attempts per account per window before the account is blocked',
      ),
    lockoutWindowSec: positiveInt
      .default(900)
      .describe('Fixed window of the account lockout counter'),
    lockoutBlockSec: positiveInt
      .default(900)
      .describe('How long a locked account stays blocked'),
    unavailableRetryAfterSec: positiveInt
      .default(5)
      .describe('Retry-After on 503 when auth storage is down'),
    existingAccountNoticeWindowSec: positiveInt
      .default(86400)
      .describe(
        'At most one "account already exists" email per user per window',
      ),
    registeredReconcileCron: cron
      .default('*/5 * * * *')
      .describe('Cron of identity.reconcile-registered'),
    registeredReconcileTz: timezone
      .default('UTC')
      .describe('Timezone of the reconcile cron'),
    registeredReconcileGraceSec: positiveInt
      .default(120)
      .describe('Users younger than this are left to the after-hook'),
    registeredReconcileBatchSize: positiveInt
      .default(500)
      .describe('Users per reconcile batch'),
    registeredReconcileMaxBatches: positiveInt
      .default(20)
      .describe('Max batches per reconcile run'),
    purgeCron: cron
      .default('15 3 * * *')
      .describe('Cron of identity.purge-expired'),
    purgeTz: timezone.default('UTC').describe('Timezone of the purge cron'),
    purgeBatchSize: positiveInt
      .default(5000)
      .describe('Rows deleted per purge statement'),
    purgeMaxBatches: positiveInt
      .default(100)
      .describe('Max purge statements per table per run'),
  }),
);
export type IdentityGuardConfig = ConfigOf<typeof identityGuardConfig>;

export const authDatabaseConfig = defineConfig(
  'authDatabase',
  {
    host: 'DB_AUTH_HOST',
    port: 'DB_AUTH_PORT',
    user: 'DB_AUTH_USER',
    password: 'DB_AUTH_PASSWORD',
    poolMax: 'DB_AUTH_POOL_MAX',
    connectionTimeoutMs: 'DB_AUTH_CONNECTION_TIMEOUT_MS',
  },
  z.object({
    host: optionalText.describe(
      'Host of the auth_user pool (defaults to DB_HOST)',
    ),
    port: z
      .union([
        z.literal('').transform(() => undefined),
        positiveInt.max(MAX_TCP_PORT),
      ])
      .optional()
      .describe('Port of the auth_user pool (defaults to DB_PORT)'),
    user: z
      .string()
      .default('auth_user')
      .describe('Role of the Better Auth pool (schema auth only)'),
    password: optionalText.describe(
      'Password of auth_user; required on api/worker unless AUTH_MODE=external (secret)',
    ),
    poolMax: positiveInt
      .default(5)
      .describe('Max connections of the auth_user pool per process'),
    connectionTimeoutMs: positiveInt
      .default(3000)
      .describe('Max wait for an auth pool connection before answering 503'),
  }),
);
export type AuthDatabaseConfig = ConfigOf<typeof authDatabaseConfig>;

const isLocalHttp = (url: unknown): boolean =>
  typeof url === 'string' &&
  URL.canParse(url) &&
  LOCAL_HTTP_ORIGINS.includes(new URL(url).origin.replace(/:\d+$/, ''));
const hostUnder = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);
const hostOf = (u: unknown): string | undefined =>
  typeof u === 'string' && URL.canParse(u) ? new URL(u).hostname : undefined;

defineConfigRule('identity-effective-cookie-prefix', (c) => {
  // Better Auth's cookie prefix only matters when Better Auth is mounted (local/hybrid).
  if (c.identity?.mode === 'external') return undefined;
  const prefix = c.identity?.cookiePrefix ?? c.app?.serviceName;
  return typeof prefix === 'string' && COOKIE_PREFIX_PATTERN.test(prefix)
    ? undefined
    : `AUTH_COOKIE_PREFIX (or APP_SERVICE_NAME fallback) must match ${COOKIE_PREFIX_PATTERN}`;
});

defineConfigRule('identity-auth-db-password', (c) =>
  c.identity?.mode !== 'external' &&
  c.app?.role !== 'migrate' &&
  !c.authDatabase?.password
    ? 'DB_AUTH_PASSWORD is required on api/worker when AUTH_MODE is local or hybrid'
    : undefined,
);
defineConfigRule('identity-secure-cookies', (c) => {
  // Cookies belong to Better Auth; the gateway/IdP owns the flags of the external cookie (§5.4).
  if (c.identity?.mode === 'external') return undefined;
  if (c.identity?.secureCookies !== false) return undefined;
  const devOrTest =
    c.app?.nodeEnv === 'development' || c.app?.nodeEnv === 'test';
  return devOrTest && isLocalHttp(c.identity?.baseUrl)
    ? undefined
    : 'AUTH_SECURE_COOKIES=false is only allowed with NODE_ENV development/test and AUTH_BASE_URL on http://localhost or http://127.0.0.1';
});
defineConfigRule('identity-cookie-domain', (c) => {
  // `crossSubDomainCookies` is Better Auth config; external mode never sets this cookie.
  if (c.identity?.mode === 'external') return undefined;
  const domain = c.identity?.cookieDomain;
  if (typeof domain !== 'string') return undefined;
  if (c.identity?.cookieDomainAllSubdomainsTrusted !== true)
    return 'AUTH_COOKIE_DOMAIN requires AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED=true (every subdomain receives the cookie)';
  if (domain !== domain.toLowerCase())
    return 'AUTH_COOKIE_DOMAIN must be lowercase';
  if (domain.startsWith('.') || domain.endsWith('.'))
    return 'AUTH_COOKIE_DOMAIN must not start or end with a dot';
  if (
    domain === 'localhost' ||
    domain.split('.').filter(Boolean).length < MIN_COOKIE_DOMAIN_LABELS
  )
    return 'AUTH_COOKIE_DOMAIN must have at least two labels and not be localhost';
  // §5.4 condition 3 / ruling S2-R23: reject IP literals and any public suffix, including the
  // private PSL section (e.g. `co.uk`, `github.io`) — a cookie scoped to the whole suffix would
  // leak to every other registrant under it.
  const parsed = parseHostname(domain, { allowPrivateDomains: true });
  if (parsed.isIp) return 'AUTH_COOKIE_DOMAIN must not be an IP literal';
  if (parsed.publicSuffix !== null && parsed.publicSuffix === domain)
    return 'AUTH_COOKIE_DOMAIN must not be a public suffix (e.g. co.uk, github.io)';
  const origins = Array.isArray(c.http?.corsOrigins) ? c.http.corsOrigins : [];
  const hosts = [hostOf(c.identity?.baseUrl), ...origins.map(hostOf)];
  return hosts.every((h) => h !== undefined && hostUnder(h, domain))
    ? undefined
    : 'host of AUTH_BASE_URL and every HTTP_CORS_ORIGINS entry must be under AUTH_COOKIE_DOMAIN';
});
defineConfigRule('identity-api-key-header-redacted', (c) => {
  const header = c.identity?.apiKeyHeader;
  if (header === DEFAULT_REDACTED_API_KEY_HEADER || typeof header !== 'string')
    return undefined;
  const extra = Array.isArray(c.logging?.extraRedact)
    ? c.logging.extraRedact
    : [];
  return extra.includes(`req.headers["${header}"]`)
    ? undefined
    : `AUTH_API_KEY_HEADER "${header}" must be redacted: add req.headers["${header}"] to LOG_EXTRA_REDACT_PATHS`;
});
defineConfigRule('identity-session-update-age', (c) => {
  const id = c.identity;
  if (
    typeof id?.sessionUpdateAgeSec !== 'number' ||
    typeof id.sessionExpiresInSec !== 'number'
  )
    return undefined;
  return id.sessionUpdateAgeSec < id.sessionExpiresInSec
    ? undefined
    : 'AUTH_SESSION_UPDATE_AGE_SEC must be less than AUTH_SESSION_EXPIRES_IN_SEC';
});
defineConfigRule('identity-session-fresh-age', (c) => {
  const id = c.identity;
  if (
    typeof id?.sessionFreshAgeSec !== 'number' ||
    typeof id.sessionExpiresInSec !== 'number'
  )
    return undefined;
  return id.sessionFreshAgeSec <= id.sessionExpiresInSec
    ? undefined
    : 'AUTH_SESSION_FRESH_AGE_SEC must be at most AUTH_SESSION_EXPIRES_IN_SEC';
});
defineConfigRule('identity-jwks-grace-period', (c) => {
  const id = c.identity;
  if (
    typeof id?.jwksGracePeriodSec !== 'number' ||
    typeof id.jwtExpiresInSec !== 'number'
  )
    return undefined;
  return id.jwksGracePeriodSec >= id.jwtExpiresInSec
    ? undefined
    : 'AUTH_JWKS_GRACE_PERIOD_SEC must be at least AUTH_JWT_EXPIRES_IN_SEC';
});
/**
 * Default của timeout từng lần thử cho provider `idp-jwks` (ruling S2-R56, suy ra từ hạn của jose để cấu hình mặc
 * định tự nhất quán). `retries + 1` lần thử cùng backoff giữa chúng phải nằm trong `AUTH_EXTERNAL_JWKS_TIMEOUT_MS`:
 * chia hạn làm `retries + 2` phần, mỗi lần thử một phần, phần dư cho backoff (full jitter, dưới `retryBaseMs·2^n`).
 * Mặc định 5000 ms, 2 retry → 1250 ms mỗi lần thử. `JwksAuthProvider` đăng ký giá trị này bằng
 * `ResiliencePolicies.setProviderDefaults`; `RESILIENCE_OVERRIDES["idp-jwks"]` vẫn thắng.
 */
export const idpJwksAttemptTimeoutMs = (
  joseTimeoutMs: number,
  retries: number,
): number => Math.max(1, Math.floor(joseTimeoutMs / (retries + 2)));

/**
 * Task 13 carry-forward (review M7): fetch JWKS chạy trong policy của provider `idp-jwks` (timeout từng lần thử,
 * retry, breaker) và bị jose huỷ sau `AUTH_EXTERNAL_JWKS_TIMEOUT_MS`. Nếu timeout từng lần thử không nhỏ hơn hạn
 * của jose thì nó không bao giờ bắn: không có lần retry nào trong hạn, và mỗi lần jose huỷ tính thành một lỗi
 * breaker do caller huỷ (không phân biệt được với upstream chậm). Timeout của policy phải tới trước (strict `<`:
 * timer của policy khởi động sau timer của jose, nên bằng nhau thì jose vẫn thắng). Không có override thì timeout
 * là `idpJwksAttemptTimeoutMs` (luôn nhỏ hơn hạn khi hạn >= 2 ms); luật chỉ nổ khi người vận hành đặt
 * `RESILIENCE_OVERRIDES["idp-jwks"].timeoutMs` xung đột (S2-R56).
 */
defineConfigRule('identity-external-jwks-timeout-below-jose', (c) => {
  const id = c.identity;
  if (id?.mode !== 'external') return undefined;
  const jose = id.externalJwksTimeoutMs;
  const overrides = c.resilience?.overrides;
  const retries =
    numberAt(overrides, IDP_JWKS_PROVIDER, 'retries') ?? c.resilience?.retries;
  if (typeof jose !== 'number' || typeof retries !== 'number')
    return 'identity external JWKS timeout rule needs the identity and resilience namespaces';
  const attempt =
    numberAt(overrides, IDP_JWKS_PROVIDER, 'timeoutMs') ??
    idpJwksAttemptTimeoutMs(jose, retries);
  return attempt < jose
    ? undefined
    : `the resilience timeout of provider "${IDP_JWKS_PROVIDER}" (${attempt}; RESILIENCE_OVERRIDES["${IDP_JWKS_PROVIDER}"].timeoutMs, default derived from AUTH_EXTERNAL_JWKS_TIMEOUT_MS) must be less than AUTH_EXTERNAL_JWKS_TIMEOUT_MS (${jose})`;
});
defineConfigRule('identity-external-jwks-cooldown', (c) => {
  const id = c.identity;
  if (
    typeof id?.externalJwksCooldownMs !== 'number' ||
    typeof id.externalJwksCacheMaxAgeMs !== 'number'
  )
    return undefined;
  return id.externalJwksCooldownMs <= id.externalJwksCacheMaxAgeMs
    ? undefined
    : 'AUTH_EXTERNAL_JWKS_COOLDOWN_MS must be at most AUTH_EXTERNAL_JWKS_CACHE_MAX_AGE_MS';
});
defineProductionRule('identity-production', (c) => {
  const id = c.identity;
  if (id?.mode === 'external') {
    const jwks = id.externalJwksUrl;
    return typeof jwks === 'string' && jwks.startsWith('https://')
      ? undefined
      : 'AUTH_EXTERNAL_JWKS_URL must be https in production';
  }
  if (typeof id?.baseUrl !== 'string' || !id.baseUrl.startsWith('https://'))
    return 'AUTH_BASE_URL must be https in production';
  if (id.secureCookies !== true)
    return 'AUTH_SECURE_COOKIES must be true in production';
  if (c.identityGuard?.rateLimitEnabled !== true)
    return 'AUTH_RATE_LIMIT_ENABLED must be true in production';
  if (
    typeof id.secret !== 'string' ||
    new Set(id.secret).size < MIN_SECRET_DISTINCT_CHARS
  )
    return `BETTER_AUTH_SECRET must contain at least ${MIN_SECRET_DISTINCT_CHARS} distinct characters in production`;
  if (
    typeof id.oidcDiscoveryUrl === 'string' &&
    !id.oidcDiscoveryUrl.startsWith('https://')
  )
    return 'AUTH_OIDC_DISCOVERY_URL must be https in production';
  return undefined;
});

/** Cho `ConditionalModule.registerWhen` (đọc env thô, trước khi Nest resolve config). */
export const isBetterAuthMode = (
  env: Record<string, string | undefined>,
): boolean => (env[AUTH_MODE_ENV] || DEFAULT_AUTH_MODE) !== 'external';
export const isExternalMode = (
  env: Record<string, string | undefined>,
): boolean => !isBetterAuthMode(env);

type AppLike = { serviceName: string };
export const effectiveCookiePrefix = (
  id: IdentityConfig,
  app: AppLike,
): string => id.cookiePrefix ?? app.serviceName;
export const effectiveTwoFactorIssuer = (
  id: IdentityConfig,
  app: AppLike,
): string => id.twoFactorIssuer ?? app.serviceName;
const baseOrigin = (id: IdentityConfig): string => {
  if (!id.baseUrl)
    throw new Error('AUTH_BASE_URL is required in local/hybrid mode');
  return new URL(id.baseUrl).origin;
};
export const effectiveJwtIssuer = (id: IdentityConfig): string =>
  id.jwtIssuer ?? baseOrigin(id);
export const effectiveJwtAudience = (id: IdentityConfig): string =>
  id.jwtAudience ?? baseOrigin(id);
