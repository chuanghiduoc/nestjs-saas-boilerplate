import { describe, expect, it } from 'vitest';
import { catalogueDiff } from '../../../../src/modules/tenancy/application/catalogue-check.js';
import { mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
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
    expect(catalogueDiff(merged, rowsFromCode())).toEqual([]);
  });
  it('lists every difference by key and field', () => {
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
    expect(catalogueDiff(merged, rows)).toEqual([
      'billing.write: in code, missing in the database',
      'ghost.read: in the database, missing in code',
      'org.read: supportEligible code=true db=false',
      'roles.write: requires code=[roles.read] db=[]',
    ]);
  });
});
