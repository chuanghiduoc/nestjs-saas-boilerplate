import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATES,
  InvalidDeliveryTransition,
  deliveryAad,
  isFinal,
  transition,
  type DeliveryEvent,
  type DeliveryState,
} from '../../../../src/modules/notifications/domain/email-delivery.js';

const EVENTS: DeliveryEvent[] = [
  { type: 'CLAIM', leaseExpired: false },
  { type: 'CLAIM', leaseExpired: true },
  { type: 'SEND_OK' },
  { type: 'TRANSIENT_FAILURE', finalAttempt: false },
  { type: 'TRANSIENT_FAILURE', finalAttempt: true },
  { type: 'PERMANENT_FAILURE' },
  { type: 'ATTEMPTS_EXHAUSTED', leaseExpired: false },
  { type: 'ATTEMPTS_EXHAUSTED', leaseExpired: true },
];
/** Bảng đầy đủ (spec §5.11): mọi cặp trạng thái × sự kiện; `null` = không hợp lệ. */
const EXPECTED: Record<DeliveryState, (DeliveryState | null)[]> = {
  PENDING: ['SENDING', 'SENDING', null, null, null, null, 'FAILED', 'FAILED'],
  // Review FB2-7: SENDING chỉ bị bỏ khi lease đã hết hạn (cùng điều kiện STUCK của `failExhausted`).
  SENDING: [
    null,
    'SENDING',
    'SENT',
    'PENDING',
    'FAILED',
    'FAILED',
    null,
    'FAILED',
  ],
  SENT: [null, null, null, null, null, null, null, null],
  FAILED: [null, null, null, null, null, null, null, null],
};

describe('EmailDelivery state machine', () => {
  for (const state of DELIVERY_STATES)
    EVENTS.forEach((event, i) => {
      const want = EXPECTED[state][i];
      it(`${state} + ${JSON.stringify(event)} → ${want ?? 'invalid'}`, () => {
        if (want === null)
          expect(() => transition(state, event)).toThrow(
            InvalidDeliveryTransition,
          );
        else expect(transition(state, event)).toBe(want);
      });
    });
  it('SENT and FAILED are final', () => {
    expect(DELIVERY_STATES.filter(isFinal)).toEqual(['SENT', 'FAILED']);
  });
  it('AAD binds the column and the public id', () => {
    expect(deliveryAad('recipient_enc', 'p1')).toBe(
      'email_deliveries:recipient_enc:-:p1',
    );
    expect(deliveryAad('params_enc', 'p1')).toBe(
      'email_deliveries:params_enc:-:p1',
    );
  });
});
