import { describe, expect, it } from 'vitest';
import {
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  assertCanBind,
  assertCanCreateRole,
  assertCanDeleteRole,
  assertCanEditRole,
  assertCanManage,
  isAdminEquivalent,
  type Actor,
} from '../../../../src/modules/tenancy/domain/escalation.js';
import {
  adminCapability,
  systemRolePermissions,
} from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { prng, randomSubset } from './prng.js';

/** `payroll.read`: quyền fixture `grantTo.admin = false`, không ownerOnly (spec §18.3 "X"). */
const merged = mergeCatalogues([
  TENANCY_CATALOGUE,
  defineCatalogue('payroll', {
    'payroll.read': {
      resource: 'payroll',
      action: 'read',
      requires: [],
      ownerOnly: false,
      apiKeyEligible: false,
      supportEligible: false,
      grantTo: { admin: false, member: false },
    },
  }),
]);
const S = (...k: string[]): ReadonlySet<string> => new Set(k);
const sys = (k: 'OWNER' | 'ADMIN' | 'MEMBER') =>
  systemRolePermissions(k, merged);
const actor = (
  permissions: ReadonlySet<string>,
  isOwner = false,
  memberRef = 'actor',
): Actor => ({ memberRef, isOwner, permissions });
const O = actor(sys('OWNER'), true);
const A = actor(sys('ADMIN'));
const C0 = S('org.read');
/** C1 = MEMBER ∪ {members.role.assign}, tính từ catalogue của test (R-X24), không viết cứng. */
const C1 = S(...sys('MEMBER'), 'members.role.assign');
const C2 = S('org.read', 'roles.read', 'invitations.read');
/** C1 + roles.write: người sửa role nhỏ nhất của ma trận. */
const Cw = actor(new Set([...C1, 'roles.write', 'roles.read']));
const X = actor(new Set([...sys('ADMIN'), 'payroll.read']));
const V = sys('ADMIN');
const SEEDS = 200;
const OWNER_ONLY = (rule: '2a' | '5') => ({
  ok: false,
  rule,
  reason: 'OWNER_ONLY',
});
const DENIED = (rule: '1' | '2' | '4') => ({
  ok: false,
  rule,
  reason: 'ESCALATION_DENIED',
});

describe('custom role rules (spec SP3 §8.4 luật 1, 2a(i)–(iii), 6; §18.3 R-*)', () => {
  it('R-1: an ADMIN creates a role strictly below itself', () => {
    expect(assertCanCreateRole(A, C1, merged)).toEqual({ ok: true });
  });
  it('R-15: creating a role equal to your own set is refused (⊊, S3-A4); for an ADMIN that set is admin-equivalent → owner_only', () => {
    expect(assertCanCreateRole(Cw, Cw.permissions, merged)).toEqual(
      DENIED('1'),
    );
    expect(assertCanCreateRole(A, sys('ADMIN'), merged)).toEqual(
      OWNER_ONLY('2a'),
    );
  });
  it('R-4: C1 + roles.write creating a role with a key it lacks → escalation_denied', () => {
    expect(assertCanCreateRole(Cw, C2, merged)).toEqual(DENIED('1'));
  });
  it('R-8: an ADMIN adding a key it lacks to a role → escalation_denied', () => {
    expect(
      assertCanEditRole(
        A,
        {
          heldByActor: false,
          oldSet: C0,
          newSet: S('org.read', 'payroll.read'),
        },
        merged,
      ),
    ).toEqual(DENIED('1'));
  });
  it('R-9: editing the role you hold → cannot_edit_own_role (rule 6), even when the edit narrows it', () => {
    expect(
      assertCanEditRole(
        Cw,
        { heldByActor: true, oldSet: Cw.permissions, newSet: C0 },
        merged,
      ),
    ).toEqual({ ok: false, rule: '6', reason: 'CANNOT_EDIT_OWN_ROLE' });
  });
  it('R-12: C1 + roles.write deleting an unused role larger than itself → escalation_denied', () => {
    expect(
      assertCanDeleteRole(
        Cw,
        new Set([...Cw.permissions, 'invitations.read']),
        merged,
      ),
    ).toEqual(DENIED('1'));
    expect(assertCanDeleteRole(Cw, C0, merged)).toEqual({ ok: true });
  });
  it('R-16: an ADMIN narrowing V ≡ ADMIN (held by Bob) → owner_only (the old set counts, SEC-C1)', () => {
    expect(
      assertCanEditRole(
        A,
        { heldByActor: false, oldSet: V, newSet: C0 },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
  });
  it('R-17: C1 + roles.write narrowing a role larger than itself → escalation_denied (old set not dominated)', () => {
    expect(
      assertCanEditRole(
        Cw,
        {
          heldByActor: false,
          oldSet: new Set([...Cw.permissions, 'invitations.read']),
          newSet: C0,
        },
        merged,
      ),
    ).toEqual(DENIED('1'));
  });
  it('R-19: the holder of X = ADMIN ∪ {payroll.read} cannot create, edit or delete an admin-equivalent role; an OWNER can', () => {
    expect(assertCanCreateRole(X, V, merged)).toEqual(OWNER_ONLY('2a'));
    expect(
      assertCanCreateRole(X, new Set([...V, 'payroll.read']), merged),
    ).toEqual(OWNER_ONLY('2a'));
    expect(
      assertCanEditRole(
        X,
        { heldByActor: false, oldSet: V, newSet: C0 },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
    expect(
      assertCanEditRole(
        X,
        { heldByActor: false, oldSet: C0, newSet: V },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
    expect(assertCanDeleteRole(X, V, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanCreateRole(O, V, merged)).toEqual({ ok: true });
    expect(
      assertCanEditRole(
        O,
        { heldByActor: false, oldSet: V, newSet: C0 },
        merged,
      ),
    ).toEqual({ ok: true });
    expect(assertCanDeleteRole(O, V, merged)).toEqual({ ok: true });
  });
  it(`U15 for role paths (generator, ${SEEDS} seeds): any old/new set ⊇ A is owner-only; an owner is never refused`, () => {
    const keys = [...merged.keys()].filter(
      (k) => merged.get(k)?.ownerOnly === false,
    );
    const adminSet = adminCapability(merged);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = prng(seed);
      const pick = () =>
        new Set(
          rnd() < 0.5
            ? [...adminSet, ...randomSubset(keys, rnd)]
            : randomSubset(keys, rnd),
        );
      const oldSet = pick();
      const newSet = pick();
      const nonOwner = actor(new Set(randomSubset(keys, rnd)));
      const adminEq =
        isAdminEquivalent(oldSet, merged) || isAdminEquivalent(newSet, merged);
      const edit = assertCanEditRole(
        nonOwner,
        { heldByActor: false, oldSet, newSet },
        merged,
      );
      if (adminEq) expect(edit, `seed ${seed}`).toEqual(OWNER_ONLY('2a'));
      if (isAdminEquivalent(newSet, merged))
        expect(
          assertCanCreateRole(nonOwner, newSet, merged),
          `seed ${seed}`,
        ).toEqual(OWNER_ONLY('2a'));
      if (isAdminEquivalent(oldSet, merged))
        expect(
          assertCanDeleteRole(nonOwner, oldSet, merged),
          `seed ${seed}`,
        ).toEqual(OWNER_ONLY('2a'));
      expect(
        assertCanEditRole(O, { heldByActor: false, oldSet, newSet }, merged),
        `seed ${seed}`,
      ).toEqual({ ok: true });
      expect(assertCanCreateRole(O, newSet, merged), `seed ${seed}`).toEqual({
        ok: true,
      });
      expect(assertCanDeleteRole(O, oldSet, merged), `seed ${seed}`).toEqual({
        ok: true,
      });
    }
  });
});

describe('binding and managing custom roles (spec SP3 §18.3 B-*)', () => {
  const C1holder = actor(C1);
  it('a role still holding an orphan key (module disabled, rollout skew) is bindable only by an owner (final review I-1)', () => {
    // C0 ⊊ perms(A), so without the orphan rule the ADMIN would pass; the orphan grants nothing today but would be
    // granted to the assignee the moment its module comes back, and the ADMIN never held it.
    const withOrphan = {
      systemKey: null,
      orphans: ['payroll.read'],
      permissions: C0,
    };
    expect(assertCanBind(A, withOrphan, merged)).toEqual(DENIED('2'));
    expect(assertCanBind(O, withOrphan, merged)).toEqual({ ok: true });
  });
  it('B-1: ADMIN assigns C1; B-21: C1 assigns C0', () => {
    expect(
      assertCanBind(
        A,
        { systemKey: null, orphans: [], permissions: C1 },
        merged,
      ),
    ).toEqual({ ok: true });
    expect(
      assertCanBind(
        C1holder,
        { systemKey: null, orphans: [], permissions: C0 },
        merged,
      ),
    ).toEqual({ ok: true });
  });
  it('B-2: C1 assigns C2 (not strictly below C1) → escalation_denied; B-3: C1 assigns ADMIN → owner_only', () => {
    expect(
      assertCanBind(
        C1holder,
        { systemKey: null, orphans: [], permissions: C2 },
        merged,
      ),
    ).toEqual(DENIED('2'));
    expect(
      assertCanBind(
        C1holder,
        { systemKey: 'ADMIN', orphans: [], permissions: sys('ADMIN') },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
  });
  it('B-7: C1 manages an ADMIN → owner_only; B-19: an ADMIN assigns a custom role equal to ADMIN → owner_only', () => {
    expect(
      assertCanManage(
        C1holder,
        { memberRef: 'a', isOwner: false, permissions: sys('ADMIN') },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
    expect(
      assertCanBind(
        A,
        { systemKey: null, orphans: [], permissions: V },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
  });
  it('B-22/B-23/B-24 (direct paths): X assigns ADMIN or V′ ≡ ADMIN, or manages an ADMIN or Bob holding V → owner_only', () => {
    expect(
      assertCanBind(
        X,
        { systemKey: 'ADMIN', orphans: [], permissions: sys('ADMIN') },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
    expect(
      assertCanBind(
        X,
        { systemKey: null, orphans: [], permissions: V },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
    expect(
      assertCanManage(
        X,
        { memberRef: 'a', isOwner: false, permissions: sys('ADMIN') },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
    expect(
      assertCanManage(
        X,
        { memberRef: 'bob', isOwner: false, permissions: V },
        merged,
      ),
    ).toEqual(OWNER_ONLY('2a'));
  });
});
