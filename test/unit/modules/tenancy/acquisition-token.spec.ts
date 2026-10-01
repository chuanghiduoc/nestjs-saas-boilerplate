import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  newAcquisitionToken,
  tokenHashHex,
  tokenUrl,
} from '../../../../src/modules/tenancy/domain/acquisition-token.js';

describe('acquisition tokens (spec SP3 §9.1: 256 bit, only the SHA-256 is stored)', () => {
  it('a token is 32 random bytes in base64url (43 chars) and its hash is 32 bytes of hex', () => {
    const { token, hashHex } = newAcquisitionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHex).toBe(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
    expect(tokenHashHex(token)).toBe(hashHex);
  });
  it('two tokens never collide in practice', () => {
    const seen = new Set(
      Array.from({ length: 1000 }, () => newAcquisitionToken().token),
    );
    expect(seen.size).toBe(1000);
  });
  it('the token goes in the URL fragment (never logged by servers, never in Referer)', () => {
    expect(tokenUrl('https://app.example.test/invitations/accept', 'abc')).toBe(
      'https://app.example.test/invitations/accept#token=abc',
    );
  });
});
