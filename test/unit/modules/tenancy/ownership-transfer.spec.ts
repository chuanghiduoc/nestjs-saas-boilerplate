import { describe, expect, it } from 'vitest';
import {
  TRANSFER_STATUSES,
  effectiveTransferStatus,
  transitionTransfer,
  type TransferEvent,
} from '../../../../src/modules/tenancy/domain/ownership-transfer.js';

const EVENTS: readonly TransferEvent[] = [
  'ACCEPT',
  'DECLINE',
  'CANCEL',
  'EXPIRE',
];
const TO = {
  ACCEPT: 'ACCEPTED',
  DECLINE: 'DECLINED',
  CANCEL: 'CANCELLED',
  EXPIRE: 'EXPIRED',
} as const;

describe('ownership transfer state machine (spec SP3 §9.3): every (status × event) pair', () => {
  for (const status of TRANSFER_STATUSES)
    for (const event of EVENTS)
      it(`${status} --${event}-->`, () => {
        expect(transitionTransfer(status, event)).toEqual(
          status === 'PENDING'
            ? { ok: true, to: TO[event] }
            : { ok: false, reason: 'NOT_PENDING' },
        );
      });
  it('a PENDING request reads as EXPIRED at expires_at', () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    expect(
      effectiveTransferStatus({ status: 'PENDING', expiresAt: at }, at),
    ).toBe('EXPIRED');
    expect(
      effectiveTransferStatus({ status: 'DECLINED', expiresAt: at }, at),
    ).toBe('DECLINED');
  });
});
