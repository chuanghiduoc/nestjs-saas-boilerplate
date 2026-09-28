import { describe, expect, it } from 'vitest';
import {
  emailHash,
  normalizeEmail,
} from '../../../../src/modules/identity/infra/better-auth/email-normalize.js';

describe('normalizeEmail', () => {
  it('same lockout key for case and whitespace variants', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
    expect(emailHash('User@Example.com ')).toBe(emailHash('user@example.com'));
  });
  it('NFC-normalizes composed and decomposed forms', () => {
    expect(normalizeEmail('é@example.com')).toBe(
      normalizeEmail('é@example.com'),
    );
  });
  it.each([
    'T̈@example.com', // T + combining diaeresis: NFC-before-lowercase would not recompose this
    'ẗ@example.com', // already-composed NFC form of the case above
    'É@EXAMPLE.com',
    'İstanbul@example.com', // Turkish dotted capital İ
    'straße@example.com', // ß control case: no special case-folding surprise
    '  User@Example.COM ',
  ])(
    'is idempotent for %j: normalizeEmail(normalizeEmail(x)) === normalizeEmail(x)',
    (input) => {
      const once = normalizeEmail(input);
      expect(normalizeEmail(once)).toBe(once);
    },
  );
});
