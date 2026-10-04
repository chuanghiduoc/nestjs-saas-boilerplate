/** Spec §14, §14.1: thu hồi tường minh, người nhận thành member (SEC-M5), role nền tảng của người nhận được ghi (N5-1). */
export const SUPPORT_GRANT_REVOKE_REASONS = [
  'REVOKED',
  'GRANTEE_BECAME_MEMBER',
  'GRANTEE_ROLE_CHANGED',
] as const;
export type SupportGrantRevokeReason =
  (typeof SUPPORT_GRANT_REVOKE_REASONS)[number];
