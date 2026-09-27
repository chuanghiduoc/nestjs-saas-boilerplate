import { describe, expect, it } from 'vitest';
import { displayName } from '../../../../src/modules/notifications/index.js';
import {
  EMAIL_FIELDS_BY_PATH,
  sanitizeDisplayName,
} from '../../../../src/modules/identity/infra/better-auth/auth-hooks.js';

describe('sanitizeDisplayName (S2-R39, IdP-sourced names)', () => {
  it('replaces every CR/LF run with one space and caps at the notifications limit', () => {
    const out = sanitizeDisplayName(`a\r\nb\nc\r${'x'.repeat(300)}`);
    expect(out.startsWith('a b c ')).toBe(true);
    expect(out).toHaveLength(200);
    expect(displayName.safeParse(out).success).toBe(true);
  });
  it('never leaves half a surrogate pair at the cut', () => {
    const out = sanitizeDisplayName(`${'x'.repeat(199)}😀tail`);
    expect(out).toBe('x'.repeat(199));
    expect(displayName.safeParse(out).success).toBe(true);
  });
  it('leaves a valid name unchanged', () => {
    expect(sanitizeDisplayName('Ada Lovelace')).toBe('Ada Lovelace');
  });
});

describe('EMAIL_FIELDS_BY_PATH', () => {
  it('normalizes the address field of every public email entry point', () => {
    expect(EMAIL_FIELDS_BY_PATH).toEqual({
      '/sign-up/email': 'email',
      '/sign-in/email': 'email',
      '/request-password-reset': 'email',
      '/send-verification-email': 'email',
      '/change-email': 'newEmail',
    });
  });
});
