import { describe, expect, it } from 'vitest';
import {
  newOrgApiKeySecret,
  orgApiKeyHashHex,
  orgApiKeyStatusOf,
} from '../../../../src/modules/tenancy/domain/org-api-key.js';
import { supportGrantStatusOf } from '../../../../src/modules/tenancy/domain/support-grant.js';

const NOW = new Date('2026-10-01T00:00:00Z');
describe('org API key secret (spec SP3 §10)', () => {
  it('oak_ + 43 base64url characters (32 random bytes); hint = prefix + 6; hash = hex SHA-256 of the whole key', () => {
    const s = newOrgApiKeySecret('oak_');
    expect(s.token).toMatch(/^oak_[A-Za-z0-9_-]{43}$/);
    expect(s.hint).toBe(s.token.slice(0, 10));
    expect(s.hint).toMatch(/^oak_[A-Za-z0-9_-]{6}$/);
    expect(s.hashHex).toBe(orgApiKeyHashHex(s.token));
    expect(s.hashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(newOrgApiKeySecret('oak_').token).not.toBe(s.token);
  });
  it('Review Focus 1: any string hashes to 32 bytes (the definer function never sees a wrong length)', () => {
    for (const raw of ['OAK_x', 'oak_', 'oak_abc\n', 'x'.repeat(10_000)])
      expect(orgApiKeyHashHex(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('status is derived: revoked wins, then expired at expires_at <= now', () => {
    expect(
      orgApiKeyStatusOf(
        { revokedAt: NOW, expiresAt: new Date(NOW.getTime() + 1) },
        NOW,
      ),
    ).toBe('REVOKED');
    expect(orgApiKeyStatusOf({ revokedAt: null, expiresAt: NOW }, NOW)).toBe(
      'EXPIRED',
    );
    expect(
      orgApiKeyStatusOf(
        { revokedAt: null, expiresAt: new Date(NOW.getTime() + 1) },
        NOW,
      ),
    ).toBe('ACTIVE');
    expect(supportGrantStatusOf({ revokedAt: null, expiresAt: NOW }, NOW)).toBe(
      'EXPIRED',
    );
  });
});
