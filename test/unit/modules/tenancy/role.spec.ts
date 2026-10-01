import { describe, expect, it } from 'vitest';
import {
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
} from '../../../../src/modules/tenancy/constants.js';
import {
  PERMISSION_KEY_PATTERN,
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  checkCustomRoleSet,
  roleDescription,
  roleName,
  sameSet,
} from '../../../../src/modules/tenancy/domain/role.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const entry = {
  resource: 'legacy',
  action: 'read',
  requires: [],
  ownerOnly: false,
  apiKeyEligible: false,
  supportEligible: false,
  grantTo: { admin: false, member: false },
  deprecated: true,
};
const merged = mergeCatalogues([
  TENANCY_CATALOGUE,
  defineCatalogue('legacy', { 'legacy.read': entry }),
]);

describe('roleName / roleDescription (Review Focus 1: code points like char_length)', () => {
  it.each([
    ['Billing', true],
    ['😀'.repeat(ROLE_NAME_MAX_LENGTH), true],
    ['😀'.repeat(ROLE_NAME_MAX_LENGTH + 1), false],
    ['', false],
    [' Billing', false],
    ['Billing ', false],
    ['\u00a0Billing', false],
    ['Billing\t', false],
  ])('%j → %s', (name, ok) => {
    expect(roleName.safeParse(name).success).toBe(ok);
  });
  it('a description may be empty and is capped in code points', () => {
    expect(roleDescription.safeParse('').success).toBe(true);
    expect(
      roleDescription.safeParse('é'.repeat(ROLE_DESCRIPTION_MAX_LENGTH))
        .success,
    ).toBe(true);
    expect(
      roleDescription.safeParse('é'.repeat(ROLE_DESCRIPTION_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
  });
});

describe('PERMISSION_KEY_PATTERN', () => {
  it('matches every key of the v1 catalogue and refuses wildcards and malformed keys (R-7)', () => {
    for (const k of TENANCY_CATALOGUE.keys)
      expect(PERMISSION_KEY_PATTERN.test(k), k).toBe(true);
    for (const bad of [
      '*',
      'org',
      'Org.read',
      'org.',
      '.read',
      'org.read.x.y',
      'org read',
    ])
      expect(PERMISSION_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('checkCustomRoleSet (spec SP3 §8.4 luật 1: tập mới đóng, key tồn tại, không deprecated, không ownerOnly)', () => {
  it('a closed set of delegable keys passes (duplicates collapse)', () => {
    const r = checkCustomRoleSet(
      ['org.read', 'members.read', 'org.read'],
      merged,
    );
    expect(r.ok && [...r.permissions].sort()).toEqual([
      'members.read',
      'org.read',
    ]);
  });
  it('the empty set passes (Review Focus 4)', () => {
    expect(checkCustomRoleSet([], merged)).toMatchObject({ ok: true });
  });
  it.each([
    ['R-6 unknown', ['ghost.read'], 'UNKNOWN_PERMISSION', ['ghost.read']],
    ['R-6 deprecated', ['legacy.read'], 'UNKNOWN_PERMISSION', ['legacy.read']],
    [
      'R-7 manage/all',
      ['org.manage', 'all.read'],
      'UNKNOWN_PERMISSION',
      ['all.read', 'org.manage'],
    ],
    [
      'R-2 ownerOnly',
      ['org.read', 'org.delete'],
      'PERMISSION_NOT_DELEGABLE',
      ['org.delete'],
    ],
    [
      'R-5 missing requires (transitive)',
      ['invitations.write'],
      'MISSING_DEPENDENCIES',
      ['invitations.read', 'roles.read'],
    ],
  ] as const)('%s → %s %j', (_name, keys, reason, listed) => {
    expect(checkCustomRoleSet(keys, merged)).toEqual({
      ok: false,
      reason,
      keys: listed,
    });
  });
  it('unknown wins over ownerOnly, ownerOnly wins over missing dependencies', () => {
    expect(
      checkCustomRoleSet(['ghost.read', 'org.delete'], merged),
    ).toMatchObject({ reason: 'UNKNOWN_PERMISSION' });
    expect(
      checkCustomRoleSet(['org.delete', 'members.role.assign'], merged),
    ).toMatchObject({ reason: 'PERMISSION_NOT_DELEGABLE' });
  });
  it('sameSet ignores order', () => {
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });
});
