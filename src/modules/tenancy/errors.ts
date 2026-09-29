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
