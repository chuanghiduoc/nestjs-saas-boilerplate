import { isLapsed } from './expiry.js';

export const INVITE_LINK_STATUSES = [
  'ACTIVE',
  'EXHAUSTED',
  'EXPIRED',
  'REVOKED',
] as const;
export type InviteLinkStatus = (typeof INVITE_LINK_STATUSES)[number];
export const INVITE_LINK_REVOKE_REASONS = [
  'REVOKED',
  'INVALIDATED',
  'ROLE_DELETED',
] as const;
export type InviteLinkRevokeReason =
  (typeof INVITE_LINK_REVOKE_REASONS)[number];

/** Spec §6.8: trạng thái suy ra, không lưu; "đang mở" = ACTIVE (cùng định nghĩa cho trần mỗi org, preview, join). */
export function inviteLinkStatusOf(
  l: {
    revokedAt: Date | null;
    expiresAt: Date;
    useCount: number;
    maxUses: number;
  },
  now: Date,
): InviteLinkStatus {
  if (l.revokedAt !== null) return 'REVOKED';
  if (isLapsed(l.expiresAt, now)) return 'EXPIRED';
  if (l.useCount >= l.maxUses) return 'EXHAUSTED';
  return 'ACTIVE';
}
