import { describe, expect, it } from 'vitest';
import { buildAbility } from '../../../../src/modules/tenancy/application/authz/ability.factory.js';
import {
  UnknownPermissionError,
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);

describe('buildAbility (spec SP3 §8.7, U7–U10, U13)', () => {
  it('U7: an empty ability refuses every catalogue key', () => {
    const a = buildAbility([], merged);
    for (const e of merged.values())
      expect(a.can(e.action, e.resource), e.key).toBe(false);
  });
  it('grants exactly the listed keys, from the resource/action fields (dotted actions intact)', () => {
    const a = buildAbility(['members.role.assign', 'org.read'], merged);
    expect(a.can('role.assign', 'members')).toBe(true);
    expect(a.can('read', 'org')).toBe(true);
    expect(a.can('update', 'org')).toBe(false);
  });
  it('U9: case and whitespace variants never match', () => {
    const a = buildAbility(['org.read'], merged);
    expect([
      a.can('Read', 'org'),
      a.can('read', 'Org'),
      a.can('read ', 'org'),
      a.can('read', ' org'),
    ]).toEqual([false, false, false, false]);
  });
  it('U10: a deprecated key never enters the ability even if a stored set still carries it', () => {
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
          grantTo: { admin: false, member: false },
          deprecated: true,
        },
      }),
    ]);
    expect(
      buildAbility(['legacy.read'], withDeprecated).can('read', 'legacy'),
    ).toBe(false);
  });
  it('U13: a key unknown to every registered catalogue is a named error, never ignored', () => {
    expect(() => buildAbility(['ghost.read'], merged)).toThrow(
      UnknownPermissionError,
    );
  });
});
