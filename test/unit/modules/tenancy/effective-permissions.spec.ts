import { describe, expect, it } from 'vitest';
import { effectivePermissions } from '../../../../src/modules/tenancy/application/authz/effective-permissions.js';
import { mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
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
  it('a custom role row on the 3A hot path fails loud (custom roles arrive with plan 3B)', () => {
    expect(() => effectivePermissions({ systemKey: null }, merged)).toThrow(
      /custom roles/,
    );
  });
});
