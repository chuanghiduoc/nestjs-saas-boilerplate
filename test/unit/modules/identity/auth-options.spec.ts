import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'vitest';
import {
  identityConfig,
  identityGuardConfig,
} from '../../../../src/modules/identity/identity.config.js';
import {
  CLIENT_IP_HEADER,
  buildAuthOptions,
} from '../../../../src/modules/identity/infra/better-auth/auth-options.js';

const noop = createAuthMiddleware(async () => undefined);
const hybrid = {
  mode: 'hybrid',
  oidcProviderId: 'corp',
  oidcDiscoveryUrl: 'https://idp.test/.well-known/openid-configuration',
  oidcClientId: 'c',
  oidcClientSecret: 's',
};
const baseInput = (env: Record<string, string> = {}) => ({
  identity: identityConfig.schema.parse({
    secret: 's'.repeat(40),
    baseUrl: 'https://api.example.test',
    ...env,
  }),
  guard: identityGuardConfig.schema.parse({}),
  app: { serviceName: 'svc' },
  corsOrigins: ['https://app.example.test'],
  database: memoryAdapter({}),
  hooks: { before: noop, after: noop },
  emails: {
    verification: async () => undefined,
    reset: async () => undefined,
    existingAccount: async () => undefined,
    changeEmailConfirmation: async () => undefined,
  },
  onUserCreated: async () => undefined,
  onApiError: () => undefined,
  log: () => undefined,
});
const input = (env: Record<string, string>) => buildAuthOptions(baseInput(env));

describe('buildAuthOptions', () => {
  it('gives verify-email its own looser defaults and independent overrides', () => {
    const defaults = input({ mode: 'local' }).rateLimit.customRules;
    expect(defaults['/verify-email']).toEqual({ window: 300, max: 20 });
    expect(defaults['/change-email']).toEqual({ window: 300, max: 3 });
    const base = baseInput();
    base.guard = identityGuardConfig.schema.parse({
      verifyEmailRateMax: 25,
      verifyEmailRateWindowSec: 600,
      emailRateMax: 2,
      emailRateWindowSec: 400,
    });
    const rules = buildAuthOptions(base).rateLimit.customRules;
    expect(rules['/verify-email']).toEqual({ window: 600, max: 25 });
    expect(rules['/change-email']).toEqual({ window: 400, max: 2 });
  });
  it('local: plugins, impersonation disabled, no session cache, fail-closed linking, IP from our header only', () => {
    const o = input({ mode: 'local' });
    expect(o.plugins.map((p) => p.id)).toEqual([
      'two-factor',
      'bearer',
      'api-key',
      'jwt',
      'admin',
    ]);
    expect(o.disabledPaths).toEqual([
      '/admin/impersonate-user',
      '/admin/stop-impersonating',
    ]);
    expect(o.session.cookieCache.enabled).toBe(false);
    expect(o.account.accountLinking).toMatchObject({
      trustedProviders: [],
      disableImplicitLinking: true,
      allowDifferentEmails: false,
      requireLocalEmailVerified: true,
    });
    expect(o.advanced.ipAddress.ipAddressHeaders).toEqual([CLIENT_IP_HEADER]);
    expect(o.advanced).toMatchObject({
      useSecureCookies: true,
      cookiePrefix: 'svc',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
    });
    expect(o.advanced).not.toHaveProperty('crossSubDomainCookies');
    expect(o.trustedOrigins).toEqual([
      'https://app.example.test',
      'https://api.example.test',
    ]);
    expect(o.rateLimit).toMatchObject({ enabled: true, storage: 'database' });
    expect(o.emailAndPassword).toMatchObject({
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
    });
  });
  /**
   * Task 40 (lỗi sản phẩm): Better Auth 1.7.6 suy `skipOriginCheck` từ môi trường khi `disableOriginCheck` không được
   * đặt (`context/create-context.mjs`: `isTest() ? true : false`, với `isTest = NODE_ENV === 'test' || TEST` truthy).
   * Bỏ mặc định thì chỉ một biến môi trường `TEST=1` cũng tắt kiểm `callbackURL`/`redirectTo` (open redirect) và lớp
   * CSRF thứ hai (spec §5.6.2). Test này chạy dưới Vitest (`NODE_ENV=test`), tức đúng điều kiện đó.
   */
  it('origin, callbackURL and CSRF checks of Better Auth are explicitly on, never inferred from NODE_ENV/TEST', async () => {
    const o = input({ mode: 'local' });
    expect(o.advanced).toMatchObject({
      disableOriginCheck: false,
      disableCSRFCheck: false,
    });
    const ctx = await betterAuth(o).$context;
    expect([ctx.skipOriginCheck, ctx.skipCSRFCheck]).toEqual([false, false]);
  });
  it('trusted providers enable implicit linking; a parent cookie domain turns on cross-subdomain cookies', () => {
    const o = input({
      googleClientId: 'g',
      googleClientSecret: 's',
      trustedProviders: 'google',
      cookieDomain: 'example.test',
      cookieDomainAllSubdomainsTrusted: 'true',
    });
    expect(o.account.accountLinking.disableImplicitLinking).toBe(false);
    expect(o.advanced).toMatchObject({
      crossSubDomainCookies: { enabled: true, domain: 'example.test' },
    });
    expect(Object.keys(o.socialProviders)).toEqual(['google']);
  });
  it('cookie contract per environment: HttpOnly always, Secure/SameSite/prefix from config (spec §5.4)', () => {
    // development/test on http://localhost: AUTH_SECURE_COOKIES=false is the only way to drop Secure.
    const dev = input({
      baseUrl: 'http://localhost:3000',
      secureCookies: 'false',
      cookieSameSite: 'strict',
      cookiePrefix: 'dev-app',
    });
    expect(dev.advanced).toMatchObject({
      useSecureCookies: false,
      cookiePrefix: 'dev-app',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      },
    });
    expect(dev.advanced).not.toHaveProperty('crossSubDomainCookies');
    // production: Secure defaults on; SameSite=none is only valid with Secure.
    const prod = input({ cookieSameSite: 'none' });
    expect(prod.advanced).toMatchObject({
      useSecureCookies: true,
      cookiePrefix: 'svc',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'none', path: '/' },
    });
  });
  it('google profile mapper only verifies email for a trusted provider with a true claim', () => {
    const profile = (emailVerified: boolean) => ({
      aud: 'g',
      azp: 'g',
      email: 'u@example.test',
      email_verified: emailVerified,
      exp: 0,
      iat: 0,
      family_name: 'F',
      given_name: 'G',
      iss: 'https://accounts.google.com',
      name: 'G F',
      picture: '',
      sub: '1',
    });
    const untrusted = input({ googleClientId: 'g', googleClientSecret: 's' })
      .socialProviders.google;
    const trusted = input({
      googleClientId: 'g',
      googleClientSecret: 's',
      trustedProviders: 'google',
    }).socialProviders.google;
    expect(untrusted?.mapProfileToUser(profile(true))).toEqual({
      emailVerified: false,
    });
    expect(trusted?.mapProfileToUser(profile(true))).toEqual({
      emailVerified: true,
    });
    expect(trusted?.mapProfileToUser(profile(false))).toEqual({
      emailVerified: false,
    });
  });
  it('hybrid adds generic OIDC', () => {
    const o = input(hybrid);
    expect(o.plugins.map((p) => p.id)).toContain('generic-oauth');
  });
  it('hybrid OIDC requires verified ID tokens (S2-R37) and its mapper is fail-closed as wired (M9)', async () => {
    const oidc = (env: Record<string, string>) => {
      const plugin = input({ ...hybrid, ...env }).plugins.find(
        (p) => p.id === 'generic-oauth',
      );
      if (plugin?.id !== 'generic-oauth')
        throw new Error('generic-oauth plugin missing');
      const config = plugin.options.config[0];
      if (!config) throw new Error('OIDC provider config missing');
      return config;
    };
    const untrusted = oidc({});
    const trusted = oidc({ trustedProviders: 'corp' });
    expect(untrusted).toMatchObject({
      providerId: 'corp',
      requireIdTokenVerification: true,
    });
    const profile = (claim: unknown) => ({
      emailVerified: true,
      email: 'u@example.test',
      email_verified: claim,
    });
    expect(await untrusted.mapProfileToUser?.(profile(true))).toEqual({
      emailVerified: false,
    });
    expect(await trusted.mapProfileToUser?.(profile(true))).toEqual({
      emailVerified: true,
    });
    expect(await trusted.mapProfileToUser?.(profile('true'))).toEqual({
      emailVerified: false,
    });
  });
  it('change email is two-step (old address confirms first, S2-R42) and never skips verification (M4); /change-email is email rate limited (M5)', () => {
    const o = input({});
    expect(Object.keys(o.user.changeEmail).sort()).toEqual([
      'enabled',
      'sendChangeEmailConfirmation',
    ]);
    expect(o.user.changeEmail.enabled).toBe(true);
    expect(o.user.changeEmail).not.toHaveProperty(
      'updateEmailWithoutVerification',
    );
    const guard = identityGuardConfig.schema.parse({});
    const emailRule = {
      window: guard.emailRateWindowSec,
      max: guard.emailRateMax,
    };
    expect(o.rateLimit.customRules).toMatchObject({
      '/request-password-reset': emailRule,
      '/send-verification-email': emailRule,
      '/change-email': emailRule,
    });
  });
  it('email callbacks outside an auth transaction run immediately with the original payload', async () => {
    const calls: string[] = [];
    const o = buildAuthOptions({
      ...baseInput(),
      emails: {
        verification: async (d) => void calls.push(`verify:${d.token}`),
        reset: async (d) => void calls.push(`reset:${d.token}`),
        existingAccount: async (d) => void calls.push(`existing:${d.user.id}`),
        changeEmailConfirmation: async (d) =>
          void calls.push(`change:${d.token}`),
      },
    });
    const user = {
      id: 'u1',
      email: 'u@example.test',
      name: 'U',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await o.emailVerification.sendVerificationEmail({
      user,
      url: 'https://api.example.test/v',
      token: 't1',
    });
    await o.emailAndPassword.sendResetPassword({
      user,
      url: 'https://api.example.test/r',
      token: 't2',
    });
    await o.emailAndPassword.onExistingUserSignUp({ user });
    await o.user.changeEmail.sendChangeEmailConfirmation({
      user,
      newEmail: 'n@example.test',
      url: 'https://api.example.test/c',
      token: 't3',
    });
    expect(calls).toEqual([
      'verify:t1',
      'reset:t2',
      'existing:u1',
      'change:t3',
    ]);
  });
});
