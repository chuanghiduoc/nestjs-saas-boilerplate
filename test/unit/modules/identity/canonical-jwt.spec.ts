import { describe, expect, it } from 'vitest';
import { canonicalJwt } from '../../../../src/modules/identity/infra/better-auth/auth-instance.js';

const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** A 32-byte HS256 signature is 43 base64url characters: the last one carries 2 unused low bits. */
const SIGNATURE = `${'A'.repeat(42)}Q`;
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jIn0.${SIGNATURE}`;
const withLast = (token: string, index: number): string =>
  `${token.slice(0, -1)}${BASE64URL.charAt(index)}`;

describe('canonicalJwt (notif-review M1: the S2-R68 dedupe key)', () => {
  it('maps the 4 encodings of the last signature character to one string', () => {
    const base = BASE64URL.indexOf('Q');
    const variants = [0, 1, 2, 3].map((low) => withLast(TOKEN, base + low));
    expect(new Set(variants).size).toBe(4);
    expect(new Set(variants.map(canonicalJwt))).toEqual(new Set([TOKEN]));
  });

  it('keeps a canonical token unchanged and different signatures distinct', () => {
    expect(canonicalJwt(TOKEN)).toBe(TOKEN);
    const other = withLast(TOKEN, BASE64URL.indexOf('Q') + 4);
    expect(canonicalJwt(other)).toBe(other);
    expect(canonicalJwt(other)).not.toBe(canonicalJwt(TOKEN));
  });

  it('fails loud on anything that is not a compact JWS', () => {
    expect(() => canonicalJwt('a.b')).toThrow(/compact JWS/);
    expect(() => canonicalJwt('a.b.c.d')).toThrow(/compact JWS/);
  });
});
