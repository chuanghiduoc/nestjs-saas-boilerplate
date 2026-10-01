import { isLapsed } from './expiry.js';

export const TRANSFER_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export type TransferEvent = 'ACCEPT' | 'DECLINE' | 'CANCEL' | 'EXPIRE';
export type TransferTransition =
  { ok: true; to: TransferStatus } | { ok: false; reason: 'NOT_PENDING' };
export const TRANSFER_CANCEL_REASONS = [
  'CANCELLED',
  'MEMBER_REMOVED',
  'INITIATOR_NOT_OWNER',
] as const;
export type TransferCancelReason = (typeof TRANSFER_CANCEL_REASONS)[number];

/** Spec §9.3 (PR13). */
export function transitionTransfer(
  from: TransferStatus,
  event: TransferEvent,
): TransferTransition {
  switch (from) {
    case 'PENDING':
      switch (event) {
        case 'ACCEPT':
          return { ok: true, to: 'ACCEPTED' };
        case 'DECLINE':
          return { ok: true, to: 'DECLINED' };
        case 'CANCEL':
          return { ok: true, to: 'CANCELLED' };
        case 'EXPIRE':
          return { ok: true, to: 'EXPIRED' };
        default: {
          const unknown: never = event;
          throw new Error(`unknown transfer event ${String(unknown)}`);
        }
      }
    case 'ACCEPTED':
    case 'DECLINED':
    case 'CANCELLED':
    case 'EXPIRED':
      return { ok: false, reason: 'NOT_PENDING' };
    default: {
      const unknown: never = from;
      throw new Error(`unknown transfer status ${String(unknown)}`);
    }
  }
}

export const effectiveTransferStatus = (
  r: { status: TransferStatus; expiresAt: Date },
  now: Date,
): TransferStatus =>
  r.status === 'PENDING' && isLapsed(r.expiresAt, now) ? 'EXPIRED' : r.status;
