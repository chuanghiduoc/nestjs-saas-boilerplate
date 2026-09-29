import { describe, expect, it } from 'vitest';
import { dbErrorMapper } from '../../../../src/core/database/index.js';
import { TenancyErrors } from '../../../../src/modules/tenancy/errors.js';

/** Lỗi pg thô như lúc COMMIT (trigger hoãn), có `code` + `constraint`. */
const pgError = (code: string, constraint: string): Error =>
  Object.assign(new Error('violation'), { code, constraint });

describe('tenancy constraint errors (spec SP3 §15)', () => {
  it.each([
    ['23514', 'org_members_last_owner_ck', TenancyErrors.LAST_OWNER],
    ['23514', 'organizations_restore_owner_ck', TenancyErrors.LAST_OWNER],
    ['23505', 'org_members_org_user_uq', TenancyErrors.ALREADY_MEMBER],
    [
      '23514',
      'org_roles_system_immutable',
      TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
    ],
  ])('%s %s → %s', (code, constraint, expected) => {
    expect(dbErrorMapper(pgError(code, constraint))?.error).toBe(expected);
  });
  it('codes are the lower-case keys with the spec statuses', () => {
    expect([
      TenancyErrors.LAST_OWNER.code,
      TenancyErrors.LAST_OWNER.status,
    ]).toEqual(['last_owner', 409]);
    expect([
      TenancyErrors.OWNER_ONLY.code,
      TenancyErrors.OWNER_ONLY.status,
    ]).toEqual(['owner_only', 403]);
    expect([
      TenancyErrors.ORG_LIMIT_REACHED.code,
      TenancyErrors.ORG_LIMIT_REACHED.status,
    ]).toEqual(['org_limit_reached', 422]);
  });
});
