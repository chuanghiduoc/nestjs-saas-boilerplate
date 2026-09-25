import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { securityConfig } from '../../../../src/core/security/index.js';

/** Chạy qua factory (parseConfig) để kiểm tra đúng message mà boot sẽ in ra. */
function load(keys: string, activeKid: string): unknown {
  vi.stubEnv('FIELD_ENCRYPTION_KEYS', keys);
  vi.stubEnv('FIELD_ENCRYPTION_ACTIVE_KID', activeKid);
  try {
    return securityConfig();
  } catch (e) {
    return e;
  }
}

describe('securityConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('invalid JSON fails without echoing the secret value', () => {
    const secret = 'super-secret-material';
    const err = load(`{"k1":"${secret}"`, 'k1');
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/FIELD_ENCRYPTION_KEYS/);
    expect(String(err)).not.toContain(secret);
    expect(JSON.stringify(err)).not.toContain(secret);
  });
  it('a key that is not 32 bytes fails at config validation without echoing it', () => {
    const short = randomBytes(16).toString('base64');
    const err = load(JSON.stringify({ k1: short }), 'k1');
    expect(String(err)).toMatch(/32 bytes/);
    expect(String(err)).not.toContain(short);
    expect(JSON.stringify(err)).not.toContain(short);
  });
  it('a non-string key value fails without echoing it', () => {
    const err = load(JSON.stringify({ k1: 1234567890 }), 'k1');
    expect(String(err)).toMatch(/FIELD_ENCRYPTION_KEYS/);
    expect(String(err)).not.toContain('1234567890');
  });
  it('active kid must exist in the keyring', () => {
    const err = load(
      JSON.stringify({ k1: randomBytes(32).toString('base64') }),
      'k2',
    );
    expect(String(err)).toMatch(/FIELD_ENCRYPTION_ACTIVE_KID/);
  });
  it('secrets are required (no default)', () => {
    expect(() => securityConfig()).toThrow(/FIELD_ENCRYPTION_KEYS/);
  });
  it('accepts a valid keyring with rotated keys', () => {
    const cfg = load(
      JSON.stringify({
        k1: randomBytes(32).toString('base64'),
        k2: randomBytes(32).toString('base64'),
      }),
      'k2',
    );
    expect(cfg).toMatchObject({ activeKid: 'k2' });
  });
});
