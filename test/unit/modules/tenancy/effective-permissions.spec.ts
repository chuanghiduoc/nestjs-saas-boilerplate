import { describe, expect, it } from 'vitest';
import {
  customRolePermissions,
  effectivePermissions,
} from '../../../../src/modules/tenancy/application/authz/effective-permissions.js';
import {
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import { systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';

const merged = mergeCatalogues([TenancyPermissions]);

describe('effectivePermissions (spec SP3 §7.1 bước 3.9, §8.3)', () => {
  it.each(['OWNER', 'ADMIN', 'MEMBER'] as const)(
    '%s = the system role set, sorted',
    (k) => {
      expect(effectivePermissions({ systemKey: k }, merged)).toEqual(
        [...systemRolePermissions(k, merged)].sort(),
      );
    },
  );
  it('a custom role never goes through effectivePermissions: its stored keys come only from RolePermissions', () => {
    expect(() => effectivePermissions({ systemKey: null }, merged)).toThrow(
      /RolePermissions/,
    );
  });
  it('customRolePermissions: sorted, de-duplicated, deprecated-in-code dropped, orphan keys ignored and listed (R-X23)', () => {
    const withLegacy = mergeCatalogues([
      TenancyPermissions,
      defineCatalogue('legacy', {
        'legacy.read': {
          resource: 'legacy',
          action: 'read',
          requires: [],
          ownerOnly: false,
          apiKeyEligible: false,
          supportEligible: false,
          grantTo: { admin: false, member: false },
          deprecated: true,
        },
      }),
    ]);
    expect(
      customRolePermissions(
        [
          'roles.read',
          'org.read',
          'legacy.read',
          'org.read',
          'payroll.read',
          'ghost.read',
          'payroll.read',
        ],
        withLegacy,
      ),
    ).toEqual({
      granted: ['org.read', 'roles.read'],
      orphans: ['ghost.read', 'payroll.read'],
    });
  });
  it('a set made only of orphan keys grants nothing and never throws (a disabled module, R-X21/R-X23)', () => {
    expect(customRolePermissions(['payroll.read'], merged)).toEqual({
      granted: [],
      orphans: ['payroll.read'],
    });
  });
});
