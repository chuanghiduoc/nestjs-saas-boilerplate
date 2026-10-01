import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import { defineErrorCodes } from '../../core/errors/index.js';

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
