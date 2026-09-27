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
const input = (env: Record<string, string>) => {
  const identity = identityConfig.schema.parse({
    secret: 's'.repeat(40),
    baseUrl: 'https://api.example.test',
    ...env,
  });
  return buildAuthOptions({
    identity,
    guard: identityGuardConfig.schema.parse({}),
    app: { serviceName: 'svc' },
    corsOrigins: ['https://app.example.test'],
    database: memoryAdapter({}),
    hooks: { before: noop, after: noop },
    emails: {
      verification: async () => undefined,
      reset: async () => undefined,
      existingAccount: async () => undefined,
    },
    onUserCreated: async () => undefined,
    onApiError: () => undefined,
    log: () => undefined,
  });
};

describe('buildAuthOptions', () => {
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
    const o = input({
      mode: 'hybrid',
      oidcProviderId: 'corp',
      oidcDiscoveryUrl: 'https://idp.test/.well-known/openid-configuration',
      oidcClientId: 'c',
      oidcClientSecret: 's',
    });
    expect(o.plugins.map((p) => p.id)).toContain('generic-oauth');
  });
});
