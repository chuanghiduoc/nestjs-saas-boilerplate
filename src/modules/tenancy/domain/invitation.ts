import { isLapsed } from './expiry.js';

export const INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REVOKED',
  'EXPIRED',
  'INVALIDATED',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
export type InvitationEvent = 'ACCEPT' | 'REVOKE' | 'EXPIRE' | 'INVALIDATE';
export type InvitationTransition =
  { ok: true; to: InvitationStatus } | { ok: false; reason: 'NOT_PENDING' };
/** Lý do vô hiệu lúc chấp nhận (spec §14): kiểm lại cửa + trần với người mời HIỆN TẠI (§8.4 đường b). */
export const INVALIDATION_REASONS = [
  'INVITER_GONE',
  'INVITER_LACKS_GATE',
  'INVITER_NOT_DOMINANT',
] as const;
export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

/** Spec §9.1: chỉ PENDING chuyển được; bốn trạng thái còn lại là cuối. */
export function transitionInvitation(
  from: InvitationStatus,
  event: InvitationEvent,
): InvitationTransition {
  switch (from) {
    case 'PENDING':
      switch (event) {
        case 'ACCEPT':
          return { ok: true, to: 'ACCEPTED' };
        case 'REVOKE':
          return { ok: true, to: 'REVOKED' };
        case 'EXPIRE':
          return { ok: true, to: 'EXPIRED' };
        case 'INVALIDATE':
          return { ok: true, to: 'INVALIDATED' };
        default: {
          const unknown: never = event;
          throw new Error(`unknown invitation event ${String(unknown)}`);
        }
      }
    case 'ACCEPTED':
    case 'REVOKED':
    case 'EXPIRED':
    case 'INVALIDATED':
      return { ok: false, reason: 'NOT_PENDING' };
    default: {
      const unknown: never = from;
      throw new Error(`unknown invitation status ${String(unknown)}`);
    }
  }
}

/** Hết hạn suy ra từ thời gian (S3-A24): PENDING quá hạn hiển thị EXPIRED, dòng chỉ được ghi EXPIRED khi bị chạm. */
export const effectiveInvitationStatus = (
  r: { status: InvitationStatus; expiresAt: Date },
  now: Date,
): InvitationStatus =>
  r.status === 'PENDING' && isLapsed(r.expiresAt, now) ? 'EXPIRED' : r.status;
