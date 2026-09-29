import { describe, expect, it } from 'vitest';
import {
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  closure,
  isStrictSubset,
  isSubset,
} from '../../../../src/modules/tenancy/domain/permission-set.js';
import {
  adminCapability,
  systemRolePermissions,
} from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('system roles (spec SP3 §8.3, U3, U6, U16)', () => {
  it('U6: role × permission matrix (any diff here must be reviewed)', () => {
    expect(sorted(systemRolePermissions('OWNER', merged))).toEqual(
      [...TENANCY_CATALOGUE.keys].sort(),
    );
    expect(sorted(systemRolePermissions('ADMIN', merged))).toEqual([
      'api_keys.read',
      'api_keys.write_all',
      'api_keys.write_own',
      'billing.read',
      'invitations.read',
      'invitations.write',
      'members.read',
      'members.remove',
      'members.role.assign',
      'org.read',
      'org.update',
      'roles.read',
      'roles.write',
      'support_access.read',
    ]);
    expect(sorted(systemRolePermissions('MEMBER', merged))).toEqual([
      'members.read',
      'org.read',
      'roles.read',
    ]);
  });
  it('U3: every system role is closed under requires; OWNER is every non-deprecated key', () => {
    for (const k of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      const s = systemRolePermissions(k, merged);
      expect(sorted(closure(s, merged)), k).toEqual(sorted(s));
    }
    const withDeprecated = mergeCatalogues([
      TENANCY_CATALOGUE,
      defineCatalogue('legacy', {
        'legacy.read': {
          resource: 'legacy',
          action: 'read',
          requires: [],
          ownerOnly: false,
          apiKeyEligible: false,
          supportEligible: false,
          grantTo: { admin: true, member: true },
          deprecated: true,
        },
      }),
    ]);
    for (const k of ['OWNER', 'ADMIN', 'MEMBER'] as const)
      expect(
        systemRolePermissions(k, withDeprecated).has('legacy.read'),
        k,
      ).toBe(false);
  });
  it('MEMBER ⊊ ADMIN ⊊ OWNER', () => {
    const [o, a, m] = (['OWNER', 'ADMIN', 'MEMBER'] as const).map((k) =>
      systemRolePermissions(k, merged),
    );
    expect(isStrictSubset(m!, a!)).toBe(true);
    expect(isStrictSubset(a!, o!)).toBe(true);
    expect(isSubset(a!, a!)).toBe(true);
    expect(isStrictSubset(a!, a!)).toBe(false);
  });
  it('U16: no API-key-eligible or support-eligible set contains the admin capability A', () => {
    const A = adminCapability(merged);
    const eligible = (pick: 'apiKeyEligible' | 'supportEligible') =>
      new Set(
        [...merged.values()]
          .filter((e) => e[pick] && !e.deprecated)
          .map((e) => e.key),
      );
    for (const pick of ['apiKeyEligible', 'supportEligible'] as const)
      expect(isSubset(A, closure(eligible(pick), merged)), pick).toBe(false);
  });
  it('closure adds requires transitively and refuses unknown keys', () => {
    expect(sorted(closure(['members.role.assign'], merged))).toEqual([
      'members.read',
      'members.role.assign',
      'roles.read',
    ]);
    expect(() => closure(['ghost.read'], merged)).toThrow(
      'Permission "ghost.read" is not in any registered catalogue',
    );
  });
});
