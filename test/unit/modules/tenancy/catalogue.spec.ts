import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CatalogueError,
  catalogueEntrySchema,
  catalogueProblems,
  defineCatalogue,
  mergeCatalogues,
  type CatalogueEntryDef,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import { NO_WILDCARD } from '../../../../src/modules/tenancy/application/authz/ability.factory.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const entry = (
  resource: string,
  action: string,
  over: Partial<CatalogueEntryDef> = {},
): CatalogueEntryDef => ({
  resource,
  action,
  requires: [],
  ownerOnly: false,
  apiKeyEligible: false,
  supportEligible: false,
  grantTo: { admin: false, member: false },
  ...over,
});

describe('permission catalogue (spec SP3 §8.2, U1–U5, U12)', () => {
  it('the tenancy catalogue v1 has the 19 keys of the spec and passes every check', () => {
    expect(TENANCY_CATALOGUE.keys).toHaveLength(19);
    expect(catalogueProblems([TENANCY_CATALOGUE])).toEqual([]);
    expect(
      mergeCatalogues([TENANCY_CATALOGUE]).get('members.role.assign'),
    ).toMatchObject({
      resource: 'members',
      action: 'role.assign',
      catalogue: 'tenancy',
      deprecated: false,
    });
  });
  it('U1: keys are unique across catalogues, match the regex and never name the CASL wildcards', () => {
    const dup = defineCatalogue('feature', {
      'org.read': entry('org', 'read'),
    });
    expect(catalogueProblems([TENANCY_CATALOGUE, dup])).toContain(
      'duplicate key "org.read" (tenancy, feature)',
    );
    expect(
      catalogueProblems([
        defineCatalogue('x', { 'org.manage': entry('org', 'manage') }),
      ]),
    ).toContain(
      '"org.manage": action must match the pattern and not be "manage"',
    );
    expect(
      catalogueProblems([
        defineCatalogue('x', { 'all.read': entry('all', 'read') }),
      ]),
    ).toContain('"all.read": resource must match the pattern and not be "all"');
    expect(
      catalogueProblems([
        defineCatalogue('x', { 'Org.read': entry('Org', 'read') }),
      ]),
    ).toContain('"Org.read": resource must match the pattern and not be "all"');
    expect(
      catalogueProblems([
        defineCatalogue('x', { 'org.read': entry('org', 'reads') }),
      ]),
    ).toContain('"org.read": key must equal resource.action ("org.reads")');
  });
  it('U12: no key of the merged catalogue can equal the ability sentinel (regex starts with [a-z])', () => {
    const merged = mergeCatalogues([TENANCY_CATALOGUE]);
    for (const e of merged.values())
      expect([e.resource, e.action]).not.toContain(NO_WILDCARD);
    expect(
      catalogueProblems([
        defineCatalogue('x', {
          [`${NO_WILDCARD}.read`]: entry(NO_WILDCARD, 'read'),
        }),
      ]),
    ).not.toEqual([]);
  });
  it('U2: requires targets exist, form no cycle, and an active key never requires a deprecated one', () => {
    expect(
      catalogueProblems([
        defineCatalogue('x', {
          'a.read': entry('a', 'read', { requires: ['b.read'] }),
        }),
      ]),
    ).toContain('"a.read" requires unknown "b.read"');
    expect(
      catalogueProblems([
        defineCatalogue('x', {
          'a.read': entry('a', 'read', { requires: ['b.read'] }),
          'b.read': entry('b', 'read', { requires: ['a.read'] }),
        }),
      ]),
    ).toContain('requires cycle through "a.read"');
    expect(
      catalogueProblems([
        defineCatalogue('x', {
          'a.read': entry('a', 'read', { requires: ['b.read'] }),
          'b.read': entry('b', 'read', { deprecated: true }),
        }),
      ]),
    ).toContain('"a.read" is active but requires deprecated "b.read"');
  });
  it('U3: the admin and member allow-lists are closed under requires', () => {
    expect(
      catalogueProblems([
        defineCatalogue('x', {
          'a.write': entry('a', 'write', {
            requires: ['a.read'],
            grantTo: { admin: true, member: false },
          }),
          'a.read': entry('a', 'read'),
        }),
      ]),
    ).toContain('grantTo.admin is not closed: "a.write" requires "a.read"');
  });
  it('U4: grantTo is required at compile time and at runtime', () => {
    expectTypeOf<CatalogueEntryDef>().toHaveProperty('grantTo');
    const { grantTo: _dropped, ...withoutGrant } = entry('a', 'read');
    expect(catalogueEntrySchema.safeParse(withoutGrant).success).toBe(false);
  });
  it('U5: an ownerOnly entry is granted to nobody else and is not eligible for keys or support', () => {
    const bad = defineCatalogue('x', {
      'a.delete': entry('a', 'delete', {
        ownerOnly: true,
        apiKeyEligible: true,
        grantTo: { admin: true, member: false },
      }),
    });
    expect(catalogueProblems([bad])).toEqual(
      expect.arrayContaining([
        '"a.delete" is ownerOnly but granted to admin or member',
        '"a.delete" is ownerOnly but eligible for API keys or support',
      ]),
    );
  });
  it('mergeCatalogues throws a CatalogueError listing every problem (fail loud at boot)', () => {
    const dup = defineCatalogue('feature', {
      'org.read': entry('org', 'read'),
    });
    expect(() => mergeCatalogues([TENANCY_CATALOGUE, dup])).toThrow(
      CatalogueError,
    );
  });
});
