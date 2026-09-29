import { describe, expect, it } from 'vitest';
import {
  defineCatalogue,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  assertCanBind,
  assertCanManage,
  assertNotSelf,
  dominates,
  isAdminEquivalent,
  type Actor,
} from '../../../../src/modules/tenancy/domain/escalation.js';
import {
  closure,
  isStrictSubset,
} from '../../../../src/modules/tenancy/domain/permission-set.js';
import {
  adminCapability,
  systemRolePermissions,
} from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { prng, randomSubset } from './prng.js';

/** Catalogue fixture: `payroll.read` KHÔNG cấp cho admin (luật 2a theo tập, spec §18.3 "X"). */
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
const perms = (k: 'OWNER' | 'ADMIN' | 'MEMBER') =>
  systemRolePermissions(k, merged);
const actor = (k: 'OWNER' | 'ADMIN' | 'MEMBER', ref = `m-${k}`): Actor => ({
  memberRef: ref,
  isOwner: k === 'OWNER',
  permissions: perms(k),
});
const role = (k: 'OWNER' | 'ADMIN' | 'MEMBER') => ({
  systemKey: k,
  permissions: perms(k),
});
const managed = (k: 'OWNER' | 'ADMIN' | 'MEMBER', ref = `t-${k}`) => ({
  memberRef: ref,
  isOwner: k === 'OWNER',
  permissions: perms(k),
});
const X: Actor = {
  memberRef: 'x',
  isOwner: false,
  permissions: new Set([...perms('ADMIN'), 'payroll.read']),
};
const SEEDS = 200;

describe('binding and managing (spec SP3 §8.4, rules 2, 2a, 3, 4, 5)', () => {
  it('B-4: an ADMIN assigning OWNER → owner_only (rule 5); B-5: an OWNER assigning OWNER → allowed', () => {
    expect(assertCanBind(actor('ADMIN'), role('OWNER'), merged)).toEqual({
      ok: false,
      rule: '5',
      reason: 'OWNER_ONLY',
    });
    expect(assertCanBind(actor('OWNER'), role('OWNER'), merged)).toEqual({
      ok: true,
    });
  });
  it('B-18: an ADMIN assigning ADMIN → owner_only (rule 2a, S3-P1)', () => {
    expect(assertCanBind(actor('ADMIN'), role('ADMIN'), merged)).toEqual({
      ok: false,
      rule: '2a',
      reason: 'OWNER_ONLY',
    });
  });
  it('an ADMIN may assign MEMBER; a MEMBER may not assign MEMBER (not strictly smaller, S3-A4)', () => {
    expect(assertCanBind(actor('ADMIN'), role('MEMBER'), merged)).toEqual({
      ok: true,
    });
    expect(assertCanBind(actor('MEMBER'), role('MEMBER'), merged)).toEqual({
      ok: false,
      rule: '2',
      reason: 'ESCALATION_DENIED',
    });
  });
  it('B-6: nobody changes their own role, owners included (rule 3)', () => {
    for (const k of ['OWNER', 'ADMIN', 'MEMBER'] as const)
      expect(assertNotSelf(actor(k, 'same'), 'same')).toEqual({
        ok: false,
        rule: '3',
        reason: 'CANNOT_CHANGE_OWN_ROLE',
      });
    expect(assertNotSelf(actor('ADMIN', 'a'), 'b')).toEqual({ ok: true });
  });
  it('B-8: an ADMIN managing another ADMIN → owner_only; B-9: an ADMIN managing an OWNER → owner_only', () => {
    expect(assertCanManage(actor('ADMIN'), managed('ADMIN'), merged)).toEqual({
      ok: false,
      rule: '2a',
      reason: 'OWNER_ONLY',
    });
    expect(assertCanManage(actor('ADMIN'), managed('OWNER'), merged)).toEqual({
      ok: false,
      rule: '5',
      reason: 'OWNER_ONLY',
    });
  });
  it('an OWNER manages another OWNER (two owners may demote each other, O-4); an ADMIN manages a MEMBER; a MEMBER manages nobody (rule 4)', () => {
    expect(assertCanManage(actor('OWNER'), managed('OWNER'), merged)).toEqual({
      ok: true,
    });
    expect(assertCanManage(actor('ADMIN'), managed('MEMBER'), merged)).toEqual({
      ok: true,
    });
    expect(assertCanManage(actor('MEMBER'), managed('MEMBER'), merged)).toEqual(
      { ok: false, rule: '4', reason: 'ESCALATION_DENIED' },
    );
  });
  it('rule 2a is about capability, not labels: X = ADMIN ∪ {payroll.read} strictly dominates ADMIN but is still refused (B-22)', () => {
    expect(dominates(X, perms('ADMIN'), merged)).toBe(true);
    expect(assertCanBind(X, role('ADMIN'), merged)).toEqual({
      ok: false,
      rule: '2a',
      reason: 'OWNER_ONLY',
    });
    expect(assertCanManage(X, managed('ADMIN'), merged)).toEqual({
      ok: false,
      rule: '2a',
      reason: 'OWNER_ONLY',
    });
  });
  it('rule 2a compares closures: A without a key that another key of A requires is still admin-equivalent', () => {
    const A = adminCapability(merged);
    const implied = [...A].find((k) =>
      [...A].some((o) => merged.get(o)?.requires.includes(k)),
    );
    expect(implied).toBeDefined();
    const reduced = new Set([...A].filter((k) => k !== implied));
    expect(isAdminEquivalent(reduced, merged)).toBe(true);
    expect(
      assertCanBind(X, { systemKey: null, permissions: reduced }, merged),
    ).toEqual({ ok: false, rule: '2a', reason: 'OWNER_ONLY' });
    expect(
      assertCanManage(
        X,
        { memberRef: 't', isOwner: false, permissions: reduced },
        merged,
      ),
    ).toEqual({ ok: false, rule: '2a', reason: 'OWNER_ONLY' });
  });
  it(`U15 (generator, ${SEEDS} seeds): any target set ⊇ A is refused to every non-owner and allowed to an owner`, () => {
    const A = adminCapability(merged);
    const keys = [...merged.keys()];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = prng(seed);
      const extra = randomSubset(keys, rnd);
      const containsA = rnd() < 0.5;
      const target = new Set(containsA ? [...A, ...extra] : extra);
      const nonOwner: Actor = {
        memberRef: 'n',
        isOwner: false,
        permissions: new Set(randomSubset(keys, rnd)),
      };
      const adminEq = isAdminEquivalent(target, merged);
      // Review M3: khẳng định độc lập với định nghĩa của `isAdminEquivalent` (không viết lại nó): tập dựng từ A luôn tương
      // đương admin, nên nhánh từ chối bên dưới chắc chắn được chạy ở khoảng một nửa số seed.
      if (containsA) expect(adminEq, `seed ${seed}`).toBe(true);
      const bind = assertCanBind(
        nonOwner,
        { systemKey: null, permissions: target },
        merged,
      );
      const manage = assertCanManage(
        nonOwner,
        { memberRef: 't', isOwner: false, permissions: target },
        merged,
      );
      if (adminEq) {
        expect(bind, `seed ${seed}`).toMatchObject({
          ok: false,
          reason: 'OWNER_ONLY',
        });
        expect(manage, `seed ${seed}`).toMatchObject({
          ok: false,
          reason: 'OWNER_ONLY',
        });
      }
      expect(
        assertCanBind(
          actor('OWNER'),
          { systemKey: null, permissions: target },
          merged,
        ),
        `seed ${seed}`,
      ).toEqual({ ok: true });
    }
  });
  it(`U11 (generator, ${SEEDS} seeds): isStrictSubset on closures matches the naive definition`, () => {
    const keys = [...merged.keys()];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = prng(seed);
      const s = closure(randomSubset(keys, rnd), merged);
      const t = closure(randomSubset(keys, rnd), merged);
      const naive =
        [...s].every((k) => t.has(k)) && [...t].some((k) => !s.has(k));
      expect(isStrictSubset(s, t), `seed ${seed}`).toBe(naive);
    }
  });
});
