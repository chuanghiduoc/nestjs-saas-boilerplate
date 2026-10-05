import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import { CoreErrors, defineErrorCodes } from '../../core/errors/index.js';

/** Mã do tenancy sở hữu (spec SP3 §15, cột "Chủ" = tenancy). Mã của core/identity không định nghĩa lại ở đây. */
export const TenancyErrors = defineErrorCodes({
  ESCALATION_DENIED: {
    status: HttpStatus.FORBIDDEN,
    title: 'You cannot grant or manage permissions you do not hold',
  },
  OWNER_ONLY: {
    status: HttpStatus.FORBIDDEN,
    title: 'Only an owner can do this',
  },
  CANNOT_CHANGE_OWN_ROLE: {
    status: HttpStatus.FORBIDDEN,
    title: 'You cannot change your own role',
  },
  CANNOT_EDIT_OWN_ROLE: {
    status: HttpStatus.FORBIDDEN,
    title: 'You cannot edit a role you hold',
  },
  API_KEY_NOT_ORG_SCOPED: {
    status: HttpStatus.FORBIDDEN,
    title: 'This API key cannot be used on organization routes',
  },
  ORG_CREATION_DISABLED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Organization creation is disabled',
  },
  LAST_OWNER: {
    status: HttpStatus.CONFLICT,
    title: 'An organization must keep at least one owner',
  },
  ALREADY_MEMBER: {
    status: HttpStatus.CONFLICT,
    title: 'User is already a member of this organization',
  },
  ALREADY_IN_AN_ORG: {
    status: HttpStatus.CONFLICT,
    title: 'User already belongs to an organization',
  },
  SYSTEM_ROLE_IMMUTABLE: {
    status: HttpStatus.CONFLICT,
    title: 'System roles cannot be changed',
  },
  ORG_NOT_DELETED: {
    status: HttpStatus.CONFLICT,
    title: 'Organization is not deleted',
  },
  ORG_LIMIT_REACHED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Organization limit reached',
  },
  ROLE_IN_USE: {
    status: HttpStatus.CONFLICT,
    title: 'The role is still assigned',
  },
  ROLE_NAME_TAKEN: {
    status: HttpStatus.CONFLICT,
    title: 'A role with this name already exists',
  },
  MISSING_DEPENDENCIES: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'The permission set lacks permissions it requires',
  },
  UNKNOWN_PERMISSION: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unknown or deprecated permission',
  },
  PERMISSION_NOT_DELEGABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This permission cannot be delegated',
  },
  FEATURE_DISABLED: {
    status: HttpStatus.FORBIDDEN,
    title: 'This feature is disabled',
  },
  INVITATION_EMAIL_MISMATCH: {
    status: HttpStatus.FORBIDDEN,
    title: 'This invitation was sent to another email address',
  },
  INVITATION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    title: 'Invitation not found',
  },
  INVITE_LINK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    title: 'Invite link not found',
  },
  INVITATION_PENDING_EXISTS: {
    status: HttpStatus.CONFLICT,
    title: 'A pending invitation already exists for this email',
  },
  INVITATION_NOT_PENDING: {
    status: HttpStatus.CONFLICT,
    title: 'Invitation is not pending',
  },
  INVITATION_INVALIDATED: {
    status: HttpStatus.CONFLICT,
    title: 'This invitation is no longer valid; ask for a new one',
  },
  INVITE_LINK_INVALIDATED: {
    status: HttpStatus.CONFLICT,
    title: 'This invite link is no longer valid; ask for a new one',
  },
  OWNERSHIP_TRANSFER_PENDING: {
    status: HttpStatus.CONFLICT,
    title: 'An ownership transfer is already pending',
  },
  OWNERSHIP_TRANSFER_NOT_PENDING: {
    status: HttpStatus.CONFLICT,
    title: 'Ownership transfer is not pending',
  },
  OWNERSHIP_TRANSFER_INVALIDATED: {
    status: HttpStatus.CONFLICT,
    title: 'The initiator is no longer an owner; the transfer was cancelled',
  },
  OWNER_NOT_INVITABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title:
      'The owner role cannot be granted by an invitation or an invite link',
  },
  PENDING_INVITATIONS_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Pending invitation limit reached',
  },
  INVITE_LINKS_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Open invite link limit reached',
  },
  TTL_OUT_OF_RANGE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Expiry is out of the allowed range',
  },
  PERMISSION_NOT_API_KEY_ELIGIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This permission cannot be delegated to an API key',
  },
  PERMISSION_NOT_SUPPORT_ELIGIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This permission cannot be delegated to a support grant',
  },
  /** Spec §9.7: một mã cho mọi lý do (không phải nhân viên, chưa có 2FA, bị ban, là member, không tồn tại) — không lộ lý do. */
  SUPPORT_GRANTEE_INELIGIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This user cannot receive a support grant',
  },
  API_KEYS_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Active API key limit reached',
  },
});

/** Tên constraint/trigger (migration `tenancy_core`) → mã; tên không bao giờ ra client. */
defineConstraintErrors({
  org_members_last_owner_ck: TenancyErrors.LAST_OWNER,
  organizations_restore_owner_ck: TenancyErrors.LAST_OWNER,
  org_members_org_user_uq: TenancyErrors.ALREADY_MEMBER,
  org_roles_system_immutable: TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
});

/**
 * Dòng `tenancy_users` bị bước `release` của xoá tài khoản xoá giữa upsert và khoá (spec SP3 §6.2, DB2-M10). Service đổi
 * thành `409 conflict`; không tự thử lại (thử lại sẽ tạo lại dòng cho một user đang bị xoá).
 */
export class TenancyUserVanishedError extends Error {
  constructor() {
    super(
      'tenancy_users row vanished between upsert and lock (account deletion in progress)',
    );
    this.name = 'TenancyUserVanishedError';
  }
}

/**
 * Constraint của 3B (migration `custom_role_permissions`, `org_roles_name_uq` của `tenancy_core`). `org_members_role_fk`:
 * 23001 khi xoá role còn member; 23503 trên cùng FK chỉ xảy ra khi gán role không tồn tại, mà service đã kiểm role dưới
 * khoá org trước khi ghi, nên mã chung `role_in_use` không che lỗi nào của đường app.
 */
defineConstraintErrors({
  org_role_permissions_custom_only: TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
  org_role_permissions_not_delegable: TenancyErrors.PERMISSION_NOT_DELEGABLE,
  org_role_permissions_deprecated: TenancyErrors.UNKNOWN_PERMISSION,
  org_role_permissions_closed_ck: TenancyErrors.MISSING_DEPENDENCIES,
  org_roles_name_uq: TenancyErrors.ROLE_NAME_TAKEN,
  org_members_role_fk: TenancyErrors.ROLE_IN_USE,
});
/** Constraint/trigger của migration `acquisition` (3C) → mã; tên không bao giờ ra client. */
defineConstraintErrors({
  org_invitations_pending_email_uq: TenancyErrors.INVITATION_PENDING_EXISTS,
  org_invitations_role_not_owner: TenancyErrors.OWNER_NOT_INVITABLE,
  org_invite_links_role_not_owner: TenancyErrors.OWNER_NOT_INVITABLE,
  // Xoá role còn lời mời PENDING/link chưa thu hồi: hành động FK `SET NULL (role_id)` vi phạm CHECK gắn trạng thái (DB-I2).
  org_invitations_pending_role_ck: TenancyErrors.ROLE_IN_USE,
  org_invite_links_active_role_ck: TenancyErrors.ROLE_IN_USE,
  org_ownership_transfers_pending_uq: TenancyErrors.OWNERSHIP_TRANSFER_PENDING,
  // Lớp chặn cuối nếu zod và `lower()` của Postgres lệch nhau trên một ký tự: 422, không 500.
  org_invitations_email_ck: CoreErrors.VALIDATION_FAILED,
});
/** Constraint/trigger của migration `delegation` (3D) → mã; tên không bao giờ ra client. */
defineConstraintErrors({
  org_api_key_permissions_guard: TenancyErrors.PERMISSION_NOT_API_KEY_ELIGIBLE,
  org_support_grant_permissions_guard:
    TenancyErrors.PERMISSION_NOT_SUPPORT_ELIGIBLE,
  org_api_key_permissions_closed_ck: TenancyErrors.MISSING_DEPENDENCIES,
  org_support_grant_permissions_closed_ck: TenancyErrors.MISSING_DEPENDENCIES,
  org_support_grants_grantee_not_member:
    TenancyErrors.SUPPORT_GRANTEE_INELIGIBLE,
  // Đường app thu hồi grant TRƯỚC khi thêm member/cấp lại (spec §9 MemberAdmission, §9.7): tới được đây là đua với SQL tay.
  org_members_no_active_support_grant: CoreErrors.CONFLICT,
  org_support_grants_active_uq: CoreErrors.CONFLICT,
  org_api_keys_revoked_once: CoreErrors.CONFLICT,
  org_support_grants_revoked_once: CoreErrors.CONFLICT,
  org_support_grants_first_used_once: CoreErrors.CONFLICT,
  // Lớp chặn cuối nếu zod và `btrim`/`char_length` của Postgres lệch nhau trên một ký tự: 422, không 500.
  org_api_keys_name_ck: CoreErrors.VALIDATION_FAILED,
  org_support_grants_reason_ck: CoreErrors.VALIDATION_FAILED,
});
