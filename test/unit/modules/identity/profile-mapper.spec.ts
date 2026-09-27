import { describe, expect, it } from 'vitest';
import { emailVerifiedFromProvider } from '../../../../src/modules/identity/infra/better-auth/profile-mapper.js';

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
