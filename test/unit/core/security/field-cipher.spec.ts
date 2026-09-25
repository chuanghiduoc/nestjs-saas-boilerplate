import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FieldCipher,
  FieldCipherError,
} from '../../../../src/core/security/index.js';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const AAD = 'users:totp_secret:0199aaaa-0000-7000-8000-000000000001:42';

describe('FieldCipher', () => {
  it('round-trips and produces different ciphertext each time', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const a = c.encrypt('totp-secret', AAD);
    const b = c.encrypt('totp-secret', AAD);
    expect(a).not.toBe(b);
    expect(c.decrypt(a, AAD)).toBe('totp-secret');
  });
  it('uses a 96-bit IV and a 128-bit tag in the v1 token layout', () => {
    const [version, kid, iv, , tag] = new FieldCipher({ k1 }, 'k1')
      .encrypt('x', AAD)
      .split('.');
    expect(version).toBe('v1');
    expect(kid).toBe('k1');
    expect(Buffer.from(iv!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag!, 'base64url')).toHaveLength(16);
  });
  it('decrypts old ciphertext after key rotation', () => {
    const old = new FieldCipher({ k1 }, 'k1').encrypt('x', AAD);
    const rotated = new FieldCipher({ k1, k2 }, 'k2');
    expect(rotated.decrypt(old, AAD)).toBe('x');
    expect(rotated.encrypt('y', AAD).split('.')[1]).toBe('k2');
  });
  it('rejects ciphertext moved to another row/column/org (AAD mismatch)', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const t = c.encrypt('x', AAD);
    expect(() =>
      c.decrypt(t, 'users:totp_secret:0199aaaa-0000-7000-8000-000000000001:43'),
    ).toThrow(FieldCipherError);
  });
  it('rejects a token whose kid was swapped to another key in the ring', () => {
    const c = new FieldCipher({ k1, k2 }, 'k1');
    const t = c.encrypt('x', AAD).split('.');
    expect(() => c.decrypt(['v1', 'k2', ...t.slice(2)].join('.'), AAD)).toThrow(
      FieldCipherError,
    );
  });
  it('detects tampering and truncated tags', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const t = c.encrypt('x', AAD).split('.');
    expect(() =>
      c.decrypt(
        [
          ...t.slice(0, 3),
          Buffer.from('evil').toString('base64url'),
          t[4],
        ].join('.'),
        AAD,
      ),
    ).toThrow(/authentication failed/);
    expect(() =>
      c.decrypt([...t.slice(0, 4), t[4]!.slice(0, 8)].join('.'), AAD),
    ).toThrow(FieldCipherError);
    expect(() => c.decrypt('garbage', AAD)).toThrow(/Malformed/);
  });
  it('rejects non-canonical base64url in any part (no malleable aliases of one token)', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const [v, kid, iv, ct, tag] = c.encrypt('secret', AAD).split('.') as [
      string,
      string,
      string,
      string,
      string,
    ];
    const variants = [
      [v, kid, `${iv}!!`, ct, tag],
      [v, kid, `${iv}==`, ct, tag],
      [v, kid, iv, `${ct} `, tag],
      [v, kid, iv, ct, `*${tag}`],
      [v, kid, iv.replace(/-/g, '+').replace(/_/g, '/'), ct, tag],
    ];
    // Ký tự cuối của tag (22 ký tự cho 16 byte) có 4 bit thừa: tìm alias decode ra cùng bytes.
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = alphabet
      .split('')
      .map((ch) => tag.slice(0, -1) + ch)
      .find(
        (t) =>
          t !== tag &&
          Buffer.from(t, 'base64url').equals(Buffer.from(tag, 'base64url')),
      );
    expect(alias).toBeDefined();
    variants.push([v, kid, iv, ct, alias!]);
    for (const parts of variants) {
      const token = parts.join('.');
      if (token === [v, kid, iv, ct, tag].join('.')) continue;
      expect(() => c.decrypt(token, AAD)).toThrow(/Malformed/);
    }
    expect(c.decrypt([v, kid, iv, ct, tag].join('.'), AAD)).toBe('secret');
  });
  it('round-trips an empty string', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    expect(c.decrypt(c.encrypt('', AAD), AAD)).toBe('');
  });
  it('rejects unknown key id and wrong key length without echoing key material', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(() => new FieldCipher({ k1: short }, 'k1')).toThrow(/32 bytes/);
    try {
      new FieldCipher({ k1: short }, 'k1');
    } catch (e) {
      expect(String(e)).not.toContain(short);
    }
    expect(() => new FieldCipher({ k1 }, 'k9')).toThrow(/active key/);
    expect(() =>
      new FieldCipher({ k1 }, 'k1').decrypt('v1.k9.a.b.c', AAD),
    ).toThrow(/unknown key/);
  });
});
