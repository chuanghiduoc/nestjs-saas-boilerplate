export const DELIVERY_STATES = [
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export type DeliveryEvent =
  | { type: 'CLAIM'; leaseExpired: boolean }
  | { type: 'SEND_OK' }
  | { type: 'TRANSIENT_FAILURE'; finalAttempt: boolean }
  | { type: 'PERMANENT_FAILURE' }
  | { type: 'ATTEMPTS_EXHAUSTED'; leaseExpired: boolean };

export class InvalidDeliveryTransition extends Error {
  constructor(state: DeliveryState, event: DeliveryEvent) {
    super(`Invalid email delivery transition: ${state} + ${event.type}`);
    this.name = 'InvalidDeliveryTransition';
  }
}

export const isFinal = (s: DeliveryState): boolean =>
  s === 'SENT' || s === 'FAILED';

/**
 * PENDING --claim--> SENDING --send ok--> SENT; SENDING (lease hết hạn) --claim--> SENDING (owner mới);
 * SENDING --lỗi tạm thời--> PENDING; SENDING --lỗi vĩnh viễn | lần thử cuối--> FAILED;
 * PENDING, hoặc SENDING có lease đã hết hạn --vượt NOTIFICATIONS_MAX_TOTAL_ATTEMPTS--> FAILED (cùng điều kiện
 * STUCK của `failExhausted`: SENDING còn lease là đang được gửi, không bỏ). SENT, FAILED là cuối.
 */
export function transition(
  state: DeliveryState,
  event: DeliveryEvent,
): DeliveryState {
  const invalid = (): never => {
    throw new InvalidDeliveryTransition(state, event);
  };
  switch (event.type) {
    case 'CLAIM':
      if (state === 'PENDING') return 'SENDING';
      return state === 'SENDING' && event.leaseExpired ? 'SENDING' : invalid();
    case 'SEND_OK':
      return state === 'SENDING' ? 'SENT' : invalid();
    case 'TRANSIENT_FAILURE':
      if (state !== 'SENDING') return invalid();
      return event.finalAttempt ? 'FAILED' : 'PENDING';
    case 'PERMANENT_FAILURE':
      return state === 'SENDING' ? 'FAILED' : invalid();
    case 'ATTEMPTS_EXHAUSTED':
      if (state === 'PENDING') return 'FAILED';
      return state === 'SENDING' && event.leaseExpired ? 'FAILED' : invalid();
    default: {
      const unknown: never = event;
      throw new Error(`unknown delivery event ${JSON.stringify(unknown)}`);
    }
  }
}

/** AAD của `FieldCipher` cho cột mã hoá của `email_deliveries` (spec §5.11): bảng global nên phần org là `-`. */
export const deliveryAad = (
  column: 'recipient_enc' | 'params_enc',
  publicId: string,
): string => `email_deliveries:${column}:-:${publicId}`;
