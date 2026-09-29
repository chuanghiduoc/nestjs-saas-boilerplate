import { Controller, Delete, Post } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  REQUIRE_FRESH_SESSION,
  REQUIRE_VERIFIED_EMAIL,
} from '../../../../src/modules/identity/http/fresh-session.decorator.js';
import { SESSION_ONLY } from '../../../../src/modules/identity/http/session-only.decorator.js';
import {
  NarrowingTenancyAction,
  SensitiveTenancyAction,
  TENANCY_NARROWING,
  TENANCY_POLICY,
  TENANCY_SENSITIVE,
  definePermissionCatalogue,
} from '../../../../src/modules/tenancy/http/decorators.js';
import { PoliciesGuard } from '../../../../src/modules/tenancy/http/policies.guard.js';

const Cat = definePermissionCatalogue('dec', {
  'dec.read': {
    resource: 'dec',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: true, member: true },
  },
});
@Controller('v1/orgs/:orgId/dec')
class Ctl {
  @Post() @Cat.require('dec.read') @SensitiveTenancyAction() create(
    this: void,
  ) {}
  @Delete() @Cat.require('dec.read') @NarrowingTenancyAction() revoke(
    this: void,
  ) {}
}
const r = new Reflector();

describe('tenancy decorators (spec SP3 §12, tiêu chí 18)', () => {
  it('require() records the catalogue object and keys and attaches PoliciesGuard', () => {
    expect(r.get(TENANCY_POLICY, Ctl.prototype.create)).toEqual({
      kind: 'PERMISSIONS',
      catalogue: Cat,
      keys: ['dec.read'],
    });
    expect(r.get(GUARDS_METADATA, Ctl.prototype.create)).toContain(
      PoliciesGuard,
    );
  });
  it('SensitiveTenancyAction = SessionOnly + RequireFreshSession + RequireVerifiedEmail + marker', () => {
    const h = Ctl.prototype.create;
    expect([
      r.get(TENANCY_SENSITIVE, h),
      r.get(SESSION_ONLY, h),
      r.get(REQUIRE_FRESH_SESSION, h),
      r.get(REQUIRE_VERIFIED_EMAIL, h),
    ]).toEqual([true, true, true, true]);
  });
  it('NarrowingTenancyAction = SessionOnly + marker only (revocation must stay possible with an old session, SEC3-2)', () => {
    const h = Ctl.prototype.revoke;
    expect([
      r.get(TENANCY_NARROWING, h),
      r.get(SESSION_ONLY, h),
      r.get(REQUIRE_FRESH_SESSION, h) ?? false,
    ]).toEqual([true, true, false]);
  });
  it('an unknown key is a compile error (type-level check)', () => {
    // @ts-expect-error 'dec.write' is not in the catalogue
    expect(() => Cat.require('dec.write')).not.toThrow();
  });
});
