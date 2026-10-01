import { describe, expect, it } from 'vitest';
import { dbErrorMapper } from '../../../../src/core/database/index.js';
import { CoreErrors } from '../../../../src/core/errors/index.js';
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
    [
      '23514',
      'org_role_permissions_custom_only',
      TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
    ],
    [
      '23514',
      'org_role_permissions_not_delegable',
      TenancyErrors.PERMISSION_NOT_DELEGABLE,
    ],
    [
      '23514',
      'org_role_permissions_deprecated',
      TenancyErrors.UNKNOWN_PERMISSION,
    ],
    [
      '23514',
      'org_role_permissions_closed_ck',
      TenancyErrors.MISSING_DEPENDENCIES,
    ],
    ['23505', 'org_roles_name_uq', TenancyErrors.ROLE_NAME_TAKEN],
    ['23001', 'org_members_role_fk', TenancyErrors.ROLE_IN_USE],
    [
      '23505',
      'org_invitations_pending_email_uq',
      TenancyErrors.INVITATION_PENDING_EXISTS,
    ],
    [
      '23514',
      'org_invitations_role_not_owner',
      TenancyErrors.OWNER_NOT_INVITABLE,
    ],
    [
      '23514',
      'org_invite_links_role_not_owner',
      TenancyErrors.OWNER_NOT_INVITABLE,
    ],
    ['23514', 'org_invitations_pending_role_ck', TenancyErrors.ROLE_IN_USE],
    ['23514', 'org_invite_links_active_role_ck', TenancyErrors.ROLE_IN_USE],
    [
      '23505',
      'org_ownership_transfers_pending_uq',
      TenancyErrors.OWNERSHIP_TRANSFER_PENDING,
    ],
    ['23514', 'org_invitations_email_ck', CoreErrors.VALIDATION_FAILED],
  ])('%s %s → %s', (code, constraint, expected) => {
    expect(dbErrorMapper(pgError(code, constraint))?.error).toBe(expected);
  });
  it('3C codes carry the statuses of spec §15', () => {
    expect(
      [
        TenancyErrors.FEATURE_DISABLED,
        TenancyErrors.INVITATION_EMAIL_MISMATCH,
        TenancyErrors.INVITATION_NOT_FOUND,
        TenancyErrors.INVITE_LINK_NOT_FOUND,
        TenancyErrors.INVITATION_PENDING_EXISTS,
        TenancyErrors.INVITATION_NOT_PENDING,
        TenancyErrors.INVITATION_INVALIDATED,
        TenancyErrors.INVITE_LINK_INVALIDATED,
        TenancyErrors.OWNERSHIP_TRANSFER_PENDING,
        TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING,
        TenancyErrors.OWNERSHIP_TRANSFER_INVALIDATED,
        TenancyErrors.OWNER_NOT_INVITABLE,
        TenancyErrors.PENDING_INVITATIONS_LIMIT,
        TenancyErrors.INVITE_LINKS_LIMIT,
        TenancyErrors.TTL_OUT_OF_RANGE,
      ].map((e) => [e.code, e.status]),
    ).toEqual([
      ['feature_disabled', 403],
      ['invitation_email_mismatch', 403],
      ['invitation_not_found', 404],
      ['invite_link_not_found', 404],
      ['invitation_pending_exists', 409],
      ['invitation_not_pending', 409],
      ['invitation_invalidated', 409],
      ['invite_link_invalidated', 409],
      ['ownership_transfer_pending', 409],
      ['ownership_transfer_not_pending', 409],
      ['ownership_transfer_invalidated', 409],
      ['owner_not_invitable', 422],
      ['pending_invitations_limit', 422],
      ['invite_links_limit', 422],
      ['ttl_out_of_range', 422],
    ]);
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
  it('cannot_edit_own_role is a 403 owned by tenancy (spec §15)', () => {
    expect([
      TenancyErrors.CANNOT_EDIT_OWN_ROLE.code,
      TenancyErrors.CANNOT_EDIT_OWN_ROLE.status,
    ]).toEqual(['cannot_edit_own_role', 403]);
  });
  it('3B codes carry the statuses of spec §15', () => {
    expect(
      [
        TenancyErrors.ROLE_IN_USE,
        TenancyErrors.ROLE_NAME_TAKEN,
        TenancyErrors.MISSING_DEPENDENCIES,
        TenancyErrors.UNKNOWN_PERMISSION,
        TenancyErrors.PERMISSION_NOT_DELEGABLE,
      ].map((e) => [e.code, e.status]),
    ).toEqual([
      ['role_in_use', 409],
      ['role_name_taken', 409],
      ['missing_dependencies', 422],
      ['unknown_permission', 422],
      ['permission_not_delegable', 422],
    ]);
  });
});
