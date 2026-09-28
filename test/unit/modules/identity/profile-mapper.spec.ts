import { describe, expect, it } from 'vitest';
import type { GoogleProfile } from 'better-auth/social-providers';
import {
  emailVerifiedFromProvider,
  googleProfileMapper,
  oidcProfileMapper,
} from '../../../../src/modules/identity/infra/better-auth/profile-mapper.js';

describe('account linking inputs (spec §5.4, fail-closed)', () => {
  it.each([
    [
      'untrusted provider + email_verified=true',
      'acme',
      [],
      { email_verified: true },
      false,
    ],
    ['trusted provider + missing claim', 'google', ['google'], {}, false],
    [
      'trusted provider + false',
      'google',
      ['google'],
      { email_verified: false },
      false,
    ],
    [
      'trusted provider + string "true"',
      'google',
      ['google'],
      { email_verified: 'true' },
      false,
    ],
    [
      'trusted provider + true',
      'google',
      ['google'],
      { email_verified: true },
      true,
    ],
  ])('%s → %s', (_n, provider, trusted, profile, want) => {
    expect(emailVerifiedFromProvider(provider, trusted, profile)).toBe(want);
  });
});

describe('IdP email normalization in the profile mappers (AUTH final review concern 3)', () => {
  // "A" + U+030A (NFD) → "å" (NFC) sau khi hạ chữ thường.
  const raw = '  MaÅri@Example.TEST ';
  const canonical = 'maåri@example.test';

  it('the OIDC mapper returns the canonical email so Better Auth looks up the existing user with it', () => {
    expect(oidcProfileMapper('corp', [])({ email: raw })).toEqual({
      email: canonical,
      emailVerified: false,
    });
  });
  it('the Google mapper returns the canonical email', () => {
    const profile: GoogleProfile = {
      aud: 'client',
      azp: 'client',
      email: raw,
      email_verified: true,
      exp: 0,
      family_name: 'F',
      given_name: 'G',
      iat: 0,
      iss: 'https://accounts.google.com',
      name: 'G F',
      picture: 'https://example.test/p.png',
      sub: 'sub-1',
    };
    expect(googleProfileMapper(['google'])(profile)).toEqual({
      email: canonical,
      emailVerified: true,
    });
  });
  it('a missing or non-string email claim is left to Better Auth (no email key)', () => {
    expect(oidcProfileMapper('corp', [])({})).toEqual({ emailVerified: false });
    expect(oidcProfileMapper('corp', [])({ email: 42 })).toEqual({
      emailVerified: false,
    });
  });
});
