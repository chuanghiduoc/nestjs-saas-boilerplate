import { describe, expect, it } from 'vitest';
import { inviteLinkStatusOf } from '../../../../src/modules/tenancy/domain/invite-link.js';

const now = new Date('2026-10-01T00:00:00.000Z');
const later = new Date(now.getTime() + 1000);
const base = { revokedAt: null, expiresAt: later, useCount: 0, maxUses: 2 };

describe('invite link derived status (spec SP3 §6.8: REVOKED > EXPIRED > EXHAUSTED > ACTIVE)', () => {
  it.each([
    ['ACTIVE', base],
    ['EXHAUSTED', { ...base, useCount: 2 }],
    ['EXPIRED', { ...base, expiresAt: now }],
    ['EXPIRED', { ...base, expiresAt: now, useCount: 2 }],
    ['REVOKED', { ...base, revokedAt: now }],
    ['REVOKED', { ...base, revokedAt: now, expiresAt: now, useCount: 2 }],
  ] as const)('%s', (expected, link) => {
    expect(inviteLinkStatusOf(link, now)).toBe(expected);
  });
});
