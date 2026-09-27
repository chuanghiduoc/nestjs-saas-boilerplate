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
    expect(normalizeEmail('é@example.com')).toBe(
      normalizeEmail('é@example.com'),
    );
  });
});
