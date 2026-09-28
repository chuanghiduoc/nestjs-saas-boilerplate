/** Kết quả kiểm trước khi Better Auth xoá gì (spec SP3 §9.6 bước 1). */
export type UserDeletionCheck =
  { kind: 'ALLOWED' } | { kind: 'BLOCKED_LAST_OWNER'; orgCount: number };
/**
 * Kết quả dọn tenancy trong `databaseHooks.user.delete.before` (bước 3), SAU khi session và account đã bị xoá. Đua
 * được trả thành kết quả có tên, không ném (lỗi không phải `APIError` trong hook thành 500, spec §15).
 */
export type UserDeletionRelease =
  | { kind: 'RELEASED' }
  | { kind: 'BLOCKED_RACE'; reason: 'MEMBERSHIP_CREATED' | 'LAST_OWNER' };

/**
 * Port (spec SP3 §5.2): tenancy cài bằng module `@Global()` chỉ ở process api; identity inject `@Optional()` (vắng →
 * hook bỏ qua, lớp chặn còn lại là FK `tenancy_users_auth_user_fk`). Chỉ ném với lỗi hạ tầng/lỗi lập trình.
 */
export abstract class UserDeletionGuard {
  abstract check(authUserId: string): Promise<UserDeletionCheck>;
  abstract release(authUserId: string): Promise<UserDeletionRelease>;
}
