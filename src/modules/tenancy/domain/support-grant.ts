/** Spec §14, §14.1: thu hồi tường minh, người nhận thành member (SEC-M5), role nền tảng của người nhận được ghi (N5-1). */
export const SUPPORT_GRANT_REVOKE_REASONS = [
  'REVOKED',
  'GRANTEE_BECAME_MEMBER',
  'GRANTEE_ROLE_CHANGED',
] as const;
export type SupportGrantRevokeReason =
  (typeof SUPPORT_GRANT_REVOKE_REASONS)[number];
export const SUPPORT_GRANT_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type SupportGrantStatus = (typeof SUPPORT_GRANT_STATUSES)[number];
/** Spec §9.7 state machine: REVOKED lưu, EXPIRED suy ra ở mỗi lần đọc; "vô hiệu vì owner mất quyền" suy ra ở middleware. */
export const supportGrantStatusOf = (
  g: { revokedAt: Date | null; expiresAt: Date },
  now: Date,
): SupportGrantStatus =>
  g.revokedAt !== null
    ? 'REVOKED'
    : g.expiresAt.getTime() <= now.getTime()
      ? 'EXPIRED'
      : 'ACTIVE';
