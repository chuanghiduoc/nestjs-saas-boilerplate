import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { TenancyUserVanishedError } from '../errors.js';
import type {
  TenancySubject,
  TenancyUserRef,
  TenancyUserRepository,
} from '../ports/tenancy-user-repository.js';

/**
 * Khoá `tenancy_users` của người vào org (spec §8.6 bước 2; T-25, T-7) cho chấp nhận lời mời và join link. Dòng bị bước
 * `release` của xoá tài khoản xoá giữa upsert và khoá (DB2-M10) → `409 conflict`; không thử lại (sẽ tạo lại dòng cho một
 * user đang bị xoá). Cùng cách `OrgService.create` xử lý.
 */
export async function lockAdmittedUser(
  users: TenancyUserRepository,
  subject: TenancySubject,
): Promise<TenancyUserRef> {
  try {
    return await users.upsertAndLock(subject);
  } catch (err) {
    if (err instanceof TenancyUserVanishedError)
      throw new AppError(CoreErrors.CONFLICT, {
        detail: 'This account is being deleted.',
        expected: true,
      });
    throw err;
  }
}
