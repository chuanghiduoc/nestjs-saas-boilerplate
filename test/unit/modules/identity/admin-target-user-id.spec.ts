import { describe, expect, it } from 'vitest';
import { adminTargetUserId } from '../../../../src/modules/identity/infra/better-auth/auth-hooks.js';

const ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('adminTargetUserId (spec SP3 §5.2, r7 N7-3, r8 R8-S2)', () => {
  it('reads the id exactly as the admin plugin coerces it', () => {
    expect(adminTargetUserId({ userId: ID })).toBe(ID);
    expect(adminTargetUserId({ userId: [ID] })).toBe(ID);
  });
  it.each([
    ['uppercase', { userId: ID.toUpperCase() }],
    ['braces', { userId: `{${ID}}` }],
    ['no hyphens', { userId: ID.replaceAll('-', '') }],
    ['a number', { userId: 42 }],
    ['missing', {}],
    ['two ids', { userId: [ID, ID] }],
    ['not an object', 'x'],
  ])('refuses %s (the hook answers 422 before any guard runs)', (_n, body) => {
    expect(adminTargetUserId(body)).toBeUndefined();
  });
});
