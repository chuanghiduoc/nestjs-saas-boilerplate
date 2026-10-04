/** Spec §14: lý do thu hồi org key (chuyển trạng thái ngầm khi người tạo bị gỡ: §14.1). */
export const API_KEY_REVOKE_REASONS = ['REVOKED', 'CREATOR_REMOVED'] as const;
export type ApiKeyRevokeReason = (typeof API_KEY_REVOKE_REASONS)[number];
