import { describe, expect, it } from 'vitest';
import { catalogueDiff } from '../../../../src/modules/tenancy/application/catalogue-check.js';
import {
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import type { CatalogueRow } from '../../../../src/modules/tenancy/ports/catalogue-reader.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);
const rowsFromCode = (): CatalogueRow[] =>
  [...merged.values()].map((e) => ({
    key: e.key,
    resource: e.resource,
    action: e.action,
    ownerOnly: e.ownerOnly,
    apiKeyEligible: e.apiKeyEligible,
    supportEligible: e.supportEligible,
    deprecated: e.deprecated,
    requires: [...e.requires].sort(),
  }));

describe('catalogueDiff (spec SP3 §8.8)', () => {
  it('identical catalogue and rows → no difference', () => {
    expect(catalogueDiff(merged, rowsFromCode())).toEqual({
      fatal: [],
      orphans: [],
    });
  });
  it('lists every fatal difference by key and field; a database-only key is an orphan, not fatal (R-X21)', () => {
    const rows = rowsFromCode()
      .filter((r) => r.key !== 'billing.write')
      .map((r) => (r.key === 'org.read' ? { ...r, supportEligible: false } : r))
      .map((r) => (r.key === 'roles.write' ? { ...r, requires: [] } : r));
    rows.push({
      key: 'ghost.read',
      resource: 'ghost',
      action: 'read',
      ownerOnly: false,
      apiKeyEligible: false,
      supportEligible: false,
      deprecated: false,
      requires: [],
    });
    expect(catalogueDiff(merged, rows)).toEqual({
      fatal: [
        'billing.write: in code, missing in the database',
        'org.read: supportEligible code=true db=false',
        'roles.write: requires code=[roles.read] db=[]',
      ],
      orphans: ['ghost.read'],
    });
  });
  it('orphans alone are not fatal and come back sorted', () => {
    const ghost = (key: string): CatalogueRow => ({
      key,
      resource: key.split('.')[0] ?? key,
      action: 'read',
      ownerOnly: false,
      apiKeyEligible: false,
      supportEligible: false,
      deprecated: false,
      requires: [],
    });
    expect(
      catalogueDiff(merged, [
        ...rowsFromCode(),
        ghost('zeta.read'),
        ghost('alpha.read'),
      ]),
    ).toEqual({ fatal: [], orphans: ['alpha.read', 'zeta.read'] });
  });
  it('reports ownerOnly and deprecated drift in both directions', () => {
    const rows = rowsFromCode()
      .map((r) => (r.key === 'org.delete' ? { ...r, ownerOnly: false } : r))
      .map((r) => (r.key === 'members.read' ? { ...r, deprecated: true } : r));
    expect(catalogueDiff(merged, rows).fatal).toEqual([
      'members.read: deprecated code=false db=true',
      'org.delete: ownerOnly code=true db=false',
    ]);
    const retired = mergeCatalogues([
      defineCatalogue('retired', {
        'old.read': {
          resource: 'old',
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
      catalogueDiff(retired, [
        {
          key: 'old.read',
          resource: 'old',
          action: 'read',
          ownerOnly: false,
          apiKeyEligible: false,
          supportEligible: false,
          deprecated: false,
          requires: [],
        },
      ]),
    ).toEqual({
      fatal: ['old.read: deprecated code=true db=false'],
      orphans: [],
    });
  });
});
