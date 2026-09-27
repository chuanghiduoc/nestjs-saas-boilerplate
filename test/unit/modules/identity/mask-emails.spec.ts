import { describe, expect, it } from 'vitest';
import { maskEmails } from '../../../../src/modules/identity/infra/better-auth/auth-instance.js';

describe('Better Auth log messages never carry e-mail addresses', () => {
  it('masks every address', () => {
    expect(
      maskEmails('User with email Ann.B+x@Example.test not found; cc <c@d.io>'),
    ).toBe('User with email [email] not found; cc <[email]>');
  });

  it.each([
    ['quoted', `invalid email "x.y@z.example"`, `invalid email "[email]"`],
    ['single-quoted', `user 'x@y.io' banned`, `user '[email]' banned`],
    [
      'inside a URL query',
      'Invalid callbackURL: https://evil.test/?to=a@b.io',
      'Invalid callbackURL: [email]',
    ],
    ['sub-addressed, many dots', 'a.b.c+tag-1@sub.x.y.z', '[email]'],
    ['non-ASCII local part', 'Grüße: jürgen@exämple.de', 'Grüße: [email]'],
    [
      'several on one line (trailing punctuation is masked with the address)',
      'from a@x.io to b@y.io, cc c@z.io',
      'from [email] to [email] cc [email]',
    ],
  ])('%s', (_name, input, want) => {
    expect(maskEmails(input)).toBe(want);
  });

  it('leaves messages without an address unchanged', () => {
    for (const msg of [
      'Failed to create user',
      'Invalid origin: https://evil.test',
      'an @ sign alone',
      'trailing@',
      '@leading',
    ])
      expect(maskEmails(msg)).toBe(msg);
  });
});
