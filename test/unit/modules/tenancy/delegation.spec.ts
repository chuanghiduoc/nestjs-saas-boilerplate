import { describe, expect, it } from 'vitest';
import {
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  checkDelegatedScope,
  delegableKeys,
  effectiveDelegation,
  supportPreset,
} from '../../../../src/modules/tenancy/domain/delegation.js';
import { isAdminEquivalent } from '../../../../src/modules/tenancy/domain/escalation.js';
import { closure } from '../../../../src/modules/tenancy/domain/permission-set.js';
import { systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { prng, randomSubset } from './prng.js';

const entry = (
  resource: string,
  action: string,
  o: {
    requires?: string[];
    apiKey?: boolean;
    support?: boolean;
    deprecated?: boolean;
  } = {},
) => ({
  resource,
  action,
  requires: o.requires ?? [],
  ownerOnly: false,
  apiKeyEligible: o.apiKey ?? false,
  supportEligible: o.support ?? false,
  grantTo: { admin: true, member: false },
  ...(o.deprecated ? { deprecated: true } : {}),
});
/** Catalogue fixture: chuỗi `audit.read → audit.export_meta`, quyền support không phải read, quyền deprecated. */
const merged = mergeCatalogues([
  TENANCY_CATALOGUE,
  defineCatalogue('fx', {
    'audit.export_meta': entry('audit', 'export_meta', {
      apiKey: true,
      support: true,
    }),
    'audit.read': entry('audit', 'read', {
      requires: ['audit.export_meta'],
      apiKey: true,
      support: true,
    }),
    'notes.write': entry('notes', 'write', { apiKey: true, support: true }),
    'old.read': entry('old', 'read', {
      apiKey: true,
      support: true,
      deprecated: true,
    }),
  }),
]);
const OWNER = systemRolePermissions('OWNER', merged);
const MEMBER = systemRolePermissions('MEMBER', merged);

describe('delegation model (spec SP3 §8.5, §10)', () => {
  it('eligible sets: api keys = apiKeyEligible; support = supportEligible AND action read; never owner-only or deprecated', () => {
    expect([...delegableKeys('API_KEY', merged)].sort()).toEqual(
      [
        'audit.export_meta',
        'audit.read',
        'billing.read',
        'members.read',
        'notes.write',
        'org.read',
        'roles.read',
      ].sort(),
    );
    expect(supportPreset(merged)).toEqual(
      [
        'audit.read',
        'invitations.read',
        'members.read',
        'org.read',
        'roles.read',
      ].sort(),
    );
    expect(supportPreset(merged)).not.toContain('billing.read'); // SEC-M6, S-14
  });
  it('U16: no api-key-eligible or support-eligible set is ever admin-equivalent', () => {
    expect(isAdminEquivalent(delegableKeys('API_KEY', merged), merged)).toBe(
      false,
    );
    expect(
      isAdminEquivalent(delegableKeys('SUPPORT_GRANT', merged), merged),
    ).toBe(false);
  });
  it('checkDelegatedScope: unknown/deprecated, not eligible, not closed, exceeding the grantor — each refused with the offending keys', () => {
    expect(
      checkDelegatedScope(
        'API_KEY',
        ['org.read', 'nope.read', 'old.read'],
        OWNER,
        merged,
      ),
    ).toEqual({
      ok: false,
      reason: 'UNKNOWN_PERMISSION',
      keys: ['nope.read', 'old.read'],
    });
    expect(
      checkDelegatedScope('API_KEY', ['org.read', 'org.update'], OWNER, merged),
    ).toEqual({
      ok: false,
      reason: 'NOT_ELIGIBLE',
      keys: ['org.update'],
    });
    expect(
      checkDelegatedScope('SUPPORT_GRANT', ['notes.write'], OWNER, merged),
    ).toEqual({
      ok: false,
      reason: 'NOT_ELIGIBLE',
      keys: ['notes.write'],
    });
    expect(
      checkDelegatedScope('API_KEY', ['audit.read'], OWNER, merged),
    ).toEqual({
      ok: false,
      reason: 'MISSING_DEPENDENCIES',
      keys: ['audit.export_meta'],
    });
    expect(
      checkDelegatedScope(
        'API_KEY',
        ['org.read', 'billing.read'],
        MEMBER,
        merged,
      ),
    ).toEqual({
      ok: false,
      reason: 'EXCEEDS_GRANTOR',
      keys: ['billing.read'],
    });
  });
  it('Review Focus 2: duplicates and order do not matter; the stored scope is the sorted set', () => {
    expect(
      checkDelegatedScope(
        'API_KEY',
        ['roles.read', 'org.read', 'roles.read'],
        OWNER,
        merged,
      ),
    ).toEqual({
      ok: true,
      scope: ['org.read', 'roles.read'],
    });
  });
  it('effectiveDelegation: stored ∩ grantor ∩ eligible, trimmed to a fixpoint; orphan keys grant nothing and are reported', () => {
    const grantor = new Set(['org.read', 'audit.read']); // grantor mất audit.export_meta
    expect(
      effectiveDelegation(
        'API_KEY',
        ['org.read', 'audit.read', 'audit.export_meta', 'gone.read'],
        grantor,
        merged,
      ),
    ).toEqual({
      granted: ['org.read'],
      orphans: ['gone.read'],
    });
  });
  it('generator: the effective set is always ⊆ stored ∩ grantor ∩ eligible, closed under requires, and idempotent', () => {
    const all = [...merged.keys()];
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      for (const kind of ['API_KEY', 'SUPPORT_GRANT'] as const) {
        const stored = randomSubset(all, rnd);
        const grantor = new Set(randomSubset(all, rnd));
        const { granted } = effectiveDelegation(kind, stored, grantor, merged);
        const eligible = delegableKeys(kind, merged);
        for (const k of granted)
          expect(
            stored.includes(k) && grantor.has(k) && eligible.has(k),
            `seed ${seed} ${k}`,
          ).toBe(true);
        expect([...closure(granted, merged)].sort(), `seed ${seed}`).toEqual(
          [...granted].sort(),
        );
        expect(
          effectiveDelegation(kind, granted, grantor, merged).granted,
          `seed ${seed}`,
        ).toEqual(granted);
      }
    }
  });
});
